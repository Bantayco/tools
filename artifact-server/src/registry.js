// RegistryDO: the single "global" Durable Object holding published page code.
//
//   apps      name -> current version pointer (flipped atomically to promote
//             or roll back)
//   versions  immutable HTML, named by content hash, never deleted
//   sessions  index of session UUIDs per app (for admin + new-version fan-out)
//
// Page code and session data are separate: one published version serves every
// session of an app. Session data lives in each SessionDO.

import { DurableObject } from "cloudflare:workers";
import { extractSchema, diffSchemas } from "./schema.js";
import { HttpError, rpc, sha256hex } from "./util.js";

const MAX_HTML = 1_500_000;

export class RegistryDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS apps (
        name TEXT PRIMARY KEY, current TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS versions (
        app TEXT NOT NULL, hash TEXT NOT NULL, seq INTEGER NOT NULL,
        html TEXT NOT NULL, schema TEXT NOT NULL, note TEXT, created INTEGER NOT NULL,
        PRIMARY KEY (app, hash));
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, app TEXT NOT NULL, enc TEXT NOT NULL,
        created INTEGER NOT NULL, last_active INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_app ON sessions (app, last_active);
    `);
  }

  one(query, ...args) {
    return this.sql.exec(query, ...args).toArray()[0] ?? null;
  }

  /** The version a page load serves: current pointer, or a pinned hash. */
  getVersion(app, hash = null) {
    if (!hash) {
      const row = this.one("SELECT current FROM apps WHERE name = ?", app);
      if (!row) return null;
      hash = row.current;
    }
    const v = this.one("SELECT hash, html, schema, created FROM versions WHERE app = ? AND hash = ?", app, hash);
    return v && { ...v, schema: JSON.parse(v.schema) };
  }

  currentSchema(app) {
    const v = this.getVersion(app);
    return v && { hash: v.hash, schema: v.schema };
  }

  listApps() {
    return this.sql.exec(`
      SELECT a.name, a.current, a.updated,
        (SELECT COUNT(*) FROM versions v WHERE v.app = a.name) AS versions,
        (SELECT COUNT(*) FROM sessions s WHERE s.app = a.name) AS sessions
      FROM apps a ORDER BY a.name`).toArray();
  }

  listVersions(app) {
    const cur = this.one("SELECT current FROM apps WHERE name = ?", app)?.current;
    return this.sql
      .exec("SELECT hash, seq, note, created, length(html) AS size, schema FROM versions WHERE app = ? ORDER BY seq DESC", app)
      .toArray()
      .map((v) => ({ ...v, schema: JSON.parse(v.schema), current: v.hash === cur }));
  }

  /**
   * Publish: store immutable HTML by content hash after checking its declared
   * schema against EVERY earlier version of the app (data written by any of
   * them must stay readable). Optionally promote in the same call.
   */
  publish(app, html, opts) {
    return rpc(() => this.#publish(app, html, opts));
  }

  promote(app, hash) {
    return rpc(() => this.#promote(app, hash));
  }

  async #publish(app, html, { note = "", promote = false } = {}) {
    if (typeof html !== "string" || !html.trim()) throw new HttpError(400, "html required");
    if (html.length > MAX_HTML) throw new HttpError(413, `html exceeds ${MAX_HTML} bytes`);
    const { schema, errors } = extractSchema(html);
    if (errors.length) throw new HttpError(422, "invalid schema", { errors });

    const hash = await sha256hex(html);
    const existing = this.one("SELECT hash FROM versions WHERE app = ? AND hash = ?", app, hash);
    if (!existing) {
      const breaking = [];
      for (const prev of this.sql.exec("SELECT hash, schema FROM versions WHERE app = ?", app)) {
        for (const e of diffSchemas(JSON.parse(prev.schema), schema)) breaking.push(`vs ${prev.hash.slice(0, 12)}: ${e}`);
      }
      if (breaking.length) throw new HttpError(422, "breaking schema change", { errors: breaking });
      const seq = (this.one("SELECT MAX(seq) AS m FROM versions WHERE app = ?", app)?.m ?? 0) + 1;
      this.sql.exec(
        "INSERT INTO versions (app, hash, seq, html, schema, note, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
        app, hash, seq, html, JSON.stringify(schema), String(note).slice(0, 500), Date.now(),
      );
    }
    const first = !this.one("SELECT name FROM apps WHERE name = ?", app);
    if (promote || first) await this.#promote(app, hash);
    return { app, hash, created: !existing, promoted: promote || first };
  }

  /** Flip the pointer (promote or roll back) and notify open sessions. */
  async #promote(app, hash) {
    if (!this.one("SELECT hash FROM versions WHERE app = ? AND hash = ?", app, hash)) throw new HttpError(404, "unknown version");
    this.sql.exec(
      "INSERT INTO apps (name, current, updated) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET current = excluded.current, updated = excluded.updated",
      app, hash, Date.now(),
    );
    // Fan out to sessions active in the last 30 days; each DO only pushes if it
    // has open sockets, so idle sessions cost one cheap call.
    const since = Date.now() - 30 * 86400_000;
    const ids = this.sql.exec("SELECT id FROM sessions WHERE app = ? AND last_active > ?", app, since).toArray().map((r) => r.id);
    this.ctx.waitUntil(
      Promise.allSettled(ids.map((id) => this.env.SESSION.get(this.env.SESSION.idFromName(id)).notifyVersion(hash))),
    );
    return { app, current: hash, notified: ids.length };
  }

  registerSession(id, app, enc) {
    const now = Date.now();
    this.sql.exec("INSERT OR IGNORE INTO sessions (id, app, enc, created, last_active) VALUES (?, ?, ?, ?, ?)", id, app, enc, now, now);
  }

  touchSession(id) {
    this.sql.exec("UPDATE sessions SET last_active = ? WHERE id = ?", Date.now(), id);
  }

  listSessions(app = null, limit = 200) {
    return app
      ? this.sql.exec("SELECT * FROM sessions WHERE app = ? ORDER BY last_active DESC LIMIT ?", app, limit).toArray()
      : this.sql.exec("SELECT * FROM sessions ORDER BY last_active DESC LIMIT ?", limit).toArray();
  }
}
