// Bantay client — injected into every page served by the artifact server.
//
// A page uses it like this:
//
//   import { bantay } from "/_bantay/client.js";
//   await bantay.ready;
//   render(bantay.state, bantay.log);
//   bantay.on("state", render);
//   bantay.on("log", render);
//   await bantay.save((s) => ({ ...s, title: "Week 3" }));   // retries on conflict
//   await bantay.append("pick", { player: "Ana", game: "g1", team: "KC" });
//   const ydoc = await bantay.doc();                           // Yjs, for chat/notes
//
// Roles: "blank" (no UUID; edits stay local until the first save),
// "locked" (UUID, no token), "viewer" (read + live), "owner" (read + write).
//
// Encryption (when the page schema says "encryption": "e2e", the default):
// a random data key (DEK) encrypts everything. Each passcode is stretched with
// PBKDF2 into a wrapping key + a verifier; the server stores only a hash of the
// verifier and the DEK wrapped by each wrapping key. The DEK is kept on this
// device in IndexedDB. Pairing passes the DEK wrapped by a one-time secret
// that lives only in the QR link's #fragment.

const PAGE = JSON.parse(document.getElementById("bantay-page")?.textContent || "{}");
const KDF_ITERATIONS = 600_000;
const te = new TextEncoder();
const td = new TextDecoder();

// --- schema defaults ------------------------------------------------------------

function readSchema() {
  try {
    const raw = JSON.parse(document.getElementById("bantay-schema")?.textContent || "{}");
    return { encryption: raw.encryption || "e2e", state: raw.state || {}, log: raw.log || {} };
  } catch {
    return { encryption: "e2e", state: {}, log: {} };
  }
}
const SCHEMA = readSchema();

const clone = (v) => (v === undefined ? v : structuredClone(v));

/** Missing fields resolve to declared defaults; unknown fields are preserved. */
function withDefaults(fields, raw) {
  const out = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  for (const [k, f] of Object.entries(fields)) if (!(k in out)) out[k] = clone(f.default);
  return out;
}
const stateWithDefaults = (raw) => withDefaults(SCHEMA.state, raw);
const entryWithDefaults = (e) => ({ type: e.type, data: withDefaults(SCHEMA.log[e.type]?.fields || {}, e.data) });

// --- bytes / crypto -------------------------------------------------------------

function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(str) {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

/** Passcode -> { wrapKey (AES-GCM), verifier (b64url) }. Slow on purpose. */
async function derive(passcode, saltB64) {
  const base = await crypto.subtle.importKey("raw", te.encode(passcode.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unb64url(saltB64), iterations: KDF_ITERATIONS }, base, 512),
  );
  const wrapKey = await crypto.subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]);
  return { wrapKey, verifier: b64url(bits.slice(32)) };
}

async function seal(key, bytes, aad) {
  const iv = rand(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, key, bytes);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), 12);
  return b64url(out);
}
async function open(key, b64, aad) {
  const buf = unb64url(b64);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12), additionalData: te.encode(aad) }, key, buf.slice(12)));
}

const newDek = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
const wrapDek = async (dek, wrapKey) => seal(wrapKey, await crypto.subtle.exportKey("raw", dek), "bantay-dek");
const unwrapDek = async (wrapped, wrapKey) =>
  crypto.subtle.importKey("raw", await open(wrapKey, wrapped, "bantay-dek"), "AES-GCM", true, ["encrypt", "decrypt"]);
const secretKey = (bytes) => crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);

// --- device key store (IndexedDB; CryptoKeys are stored as objects) ---------

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("bantay", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("keys");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function keyStore(mode, fn) {
  try {
    const db = await idb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("keys", mode);
      const req = fn(tx.objectStore("keys"));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return null; // private mode etc.: the key just won't persist across reloads
  }
}
const loadKey = (id) => keyStore("readonly", (s) => s.get(id));
const storeKey = (id, key) => keyStore("readwrite", (s) => s.put(key, id));
const dropKey = (id) => keyStore("readwrite", (s) => s.delete(id));

// --- HTTP -----------------------------------------------------------------------

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

export class ConflictError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "ConflictError";
    Object.assign(this, detail);
  }
}

// --- the client -----------------------------------------------------------------

class Bantay {
  constructor() {
    this.app = PAGE.app;
    this.version = PAGE.version;
    this.schema = SCHEMA;
    this.id = null;
    this.enc = SCHEMA.encryption;
    this.role = "blank";
    this.status = "local";
    this.state = stateWithDefaults({});
    this.stateVersion = 0;
    this.log = [];
    this.dirty = false;
    this._dek = null;
    this._ws = null;
    this._rid = 0;
    this._pending = new Map();
    this._queue = [];
    this._listeners = new Map();
    this._ydoc = null;
    this._docSeq = 0;
    this._docSinceCompact = 0;
    this._retry = 0;
    this.ready = this._init();
  }

  get canWrite() {
    return this.role === "blank" || this.role === "owner";
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event).delete(fn);
  }

  _emit(event, ...args) {
    for (const fn of this._listeners.get(event) || []) {
      try { fn(...args); } catch (e) { console.error(e); }
    }
  }

  _setRole(role) {
    if (this.role === role) return;
    this.role = role;
    this._emit("role", role);
  }

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this._emit("status", status);
  }

  // --- boot -------------------------------------------------------------------

  async _init() {
    const params = new URLSearchParams(location.search);
    const id = params.get("id");
    const hash = new URLSearchParams(location.hash.slice(1));
    ui.mount(this);

    if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) return this._setRole("blank");

    let meta;
    try {
      meta = await api(`/api/s/${id}/meta`);
    } catch (e) {
      if (e.status === 404) return this._setRole("blank"); // unknown UUID
      throw e;
    }
    this.id = id;
    this.meta = meta;
    this.enc = meta.enc;
    this.state = stateWithDefaults({});

    // Pairing / claim links: never redeemed on load, only by a tap.
    if (hash.get("pair") || hash.get("claim")) {
      this._setRole("locked");
      ui.offerRedeem(this, hash.get("pair") || hash.get("claim"), !!hash.get("pair"));
      return;
    }

    let who = null;
    try {
      who = await api(`/api/s/${id}/whoami`);
    } catch { /* no valid token -> Locked */ }
    if (!who) {
      this._setRole("locked");
      ui.promptUnlock(this);
      return;
    }
    this._dek = this.enc === "e2e" ? await loadKey(id) : null;
    if (this.enc === "e2e" && !this._dek) {
      // Token is valid but this device lost its key (cleared storage, admin claim).
      this._setRole("locked");
      ui.promptUnlock(this, { keyOnly: true });
      return;
    }
    await this._connect(who.role);
  }

  // --- access -----------------------------------------------------------------

  /** Try a passcode against both roles. Resolves to the new role. */
  async unlock(passcode, { keyOnly = false } = {}) {
    const [view, owner] = await Promise.all([derive(passcode, this.meta.salts.view), derive(passcode, this.meta.salts.owner)]);
    const r = await api(`/api/s/${this.id}/unlock`, {
      method: "POST",
      body: { verifiers: { view: view.verifier, owner: owner.verifier }, keyOnly },
    });
    if (this.enc === "e2e") {
      const ownerMatch = await unwrapDek(r.wrapped, owner.wrapKey).catch(() => null);
      this._dek = ownerMatch || (await unwrapDek(r.wrapped, view.wrapKey));
      await storeKey(this.id, this._dek);
    }
    this._closeSocket();
    await this._connect(r.role);
    return r.role;
  }

  /** Redeem a pairing or admin-claim code (after a user tap). */
  async redeem(fragment) {
    const [code, secret] = fragment.split(".");
    const r = await api(`/api/s/${this.id}/redeem`, { method: "POST", body: { code } });
    history.replaceState(null, "", location.pathname + location.search);
    if (this.enc === "e2e") {
      if (r.wrapped && secret) {
        this._dek = await unwrapDek(r.wrapped, await secretKey(unb64url(secret)));
        await storeKey(this.id, this._dek);
      } else {
        this._dek = await loadKey(this.id);
        if (!this._dek) return ui.promptUnlock(this, { keyOnly: true });
      }
    }
    await this._connect(r.role);
  }

  /** Owner: make a single-use pairing link (~60s) for a new device. */
  async pairLink(role = "owner") {
    let secret = null;
    let wrapped = null;
    if (this.enc === "e2e") {
      const s = rand(32);
      secret = b64url(s);
      wrapped = await wrapDek(this._dek, await secretKey(s));
    }
    const r = await api(`/api/s/${this.id}/pair`, { method: "POST", body: { role, wrapped } });
    const url = `${location.origin}${location.pathname}?id=${this.id}#pair=${r.code}${secret ? "." + secret : ""}`;
    return { url, expires: r.expires };
  }

  async agentToken() {
    return (await api(`/api/s/${this.id}/agent-token`, { method: "POST", body: {} })).token;
  }

  async signOut() {
    await api(`/api/s/${this.id}/signout`, { method: "POST", body: {} }).catch(() => {});
    await dropKey(this.id);
    location.reload();
  }

  async revokeOthers() {
    await api(`/api/s/${this.id}/revoke-others`, { method: "POST", body: {} });
  }

  async pin(version) {
    await api(`/api/s/${this.id}/pin`, { method: "POST", body: { version } });
  }

  /**
   * First save: set both passcodes, mint the UUID + owner token, upload
   * everything made while Blank, and swap the URL in place.
   */
  async create(viewPass, ownerPass) {
    if (this.role !== "blank") throw new Error("already saved");
    const salts = { view: b64url(rand(16)), owner: b64url(rand(16)) };
    const [v, o] = await Promise.all([derive(viewPass, salts.view), derive(ownerPass, salts.owner)]);
    const body = { app: this.app, salts, verifiers: { view: v.verifier, owner: o.verifier } };
    let dek = null;
    if (this.enc === "e2e") {
      dek = await newDek();
      body.wrapped = { view: await wrapDek(dek, v.wrapKey), owner: await wrapDek(dek, o.wrapKey) };
    }
    const r = await api("/api/sessions", { method: "POST", body });
    this.id = r.id;
    this.enc = r.enc;
    this._dek = r.enc === "e2e" ? dek : null;
    this.meta = { app: this.app, enc: r.enc, salts };
    if (this._dek) await storeKey(this.id, this._dek);
    const url = new URL(location.href);
    url.searchParams.set("id", r.id);
    url.hash = "";
    history.replaceState(null, "", url);

    // Replay local work through the normal channels once connected.
    const localState = this.state;
    const localLog = this.log;
    const localDoc = this._ydoc && (await this._yjs()).encodeStateAsUpdate(this._ydoc);
    this.log = [];
    await this._connect("owner");
    if (this.dirty) await this.save(() => localState);
    for (const e of localLog) await this.append(e.type, e.data);
    if (localDoc && localDoc.length > 2) await this._sendDoc(localDoc);
    this.dirty = false;
    return r.id;
  }

  // --- payload encryption -------------------------------------------------------

  async _enc(value, aad) {
    if (this.enc !== "e2e") return value;
    return seal(this._dek, te.encode(JSON.stringify(value)), `${this.id}:${aad}`);
  }
  async _dec(payload, aad) {
    if (this.enc !== "e2e" || payload == null) return payload;
    return JSON.parse(td.decode(await open(this._dek, payload, `${this.id}:${aad}`)));
  }
  async _encBytes(bytes, aad) {
    return this.enc === "e2e" ? seal(this._dek, bytes, `${this.id}:${aad}`) : b64url(bytes);
  }
  async _decBytes(b64, aad) {
    return this.enc === "e2e" ? open(this._dek, b64, `${this.id}:${aad}`) : unb64url(b64);
  }

  // --- socket -------------------------------------------------------------------

  _connect(role) {
    this._setRole(role);
    return new Promise((resolve) => {
      let first = true;
      const go = () => {
        this._setStatus("connecting");
        const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/s/${this.id}/ws`);
        this._ws = ws;
        let ping;
        ws.onopen = () => {
          this._retry = 0;
          ping = setInterval(() => ws.readyState === 1 && ws.send("ping"), 30_000);
        };
        ws.onmessage = async (ev) => {
          if (ev.data === "pong") return;
          const m = JSON.parse(ev.data);
          if (m.t === "hello") {
            await this._hello(m);
            this._setStatus("live");
            for (const q of this._queue.splice(0)) ws.send(q);
            if (first) { first = false; resolve(); }
            return;
          }
          this._message(m).catch((e) => console.error("bantay:", e));
        };
        ws.onclose = async (ev) => {
          clearInterval(ping);
          if (this._ws !== ws) return; // replaced deliberately
          this._ws = null;
          for (const [, p] of this._pending) p.reject(new Error("disconnected"));
          this._pending.clear();
          this._setStatus("offline");
          if (ev.code === 4001) {
            this._setRole("locked");
            if (first) { first = false; resolve(); }
            return ui.promptUnlock(this);
          }
          // Upgrade refused (e.g. token gone)? whoami tells us without guessing.
          const who = await api(`/api/s/${this.id}/whoami`).catch(() => null);
          if (!who) {
            this._setRole("locked");
            if (first) { first = false; resolve(); }
            return ui.promptUnlock(this);
          }
          this._setRole(who.role);
          setTimeout(go, Math.min(30_000, 500 * 2 ** this._retry++));
        };
      };
      go();
    });
  }

  _closeSocket() {
    const ws = this._ws;
    this._ws = null;
    try { ws?.close(1000); } catch { /* closed */ }
  }

  async _hello(m) {
    if (m.pinned && m.pinned !== this.version) {
      location.replace(`/${this.app}/v/${m.pinned}?id=${this.id}`);
      return new Promise(() => {});
    }
    this._setRole(m.role === "agent" ? "owner" : m.role);
    this.stateVersion = m.state.v;
    this.state = stateWithDefaults(m.state.data == null ? {} : await this._dec(m.state.data, `state:${m.state.v}`));
    this.log = [];
    for (const r of m.log) this.log.push({ n: r.n, ...entryWithDefaults(await this._dec(r.entry, `log:${r.n}`)) });
    this._docRemote = m.doc;
    if (this._ydoc) await this._loadDoc(m.doc);
    this._emit("state", this.state);
    this._emit("log", this.log);
    if (m.appVersion && m.appVersion !== this.version && !m.pinned) this._newVersion(m.appVersion);
  }

  async _message(m) {
    if (m.rid && this._pending.has(m.rid)) {
      const p = this._pending.get(m.rid);
      this._pending.delete(m.rid);
      return m.t === "error" ? p.reject(new Error(m.error)) : p.resolve(m);
    }
    switch (m.t) {
      case "state":
        this.stateVersion = m.v;
        this.state = stateWithDefaults(await this._dec(m.data, `state:${m.v}`));
        return this._emit("state", this.state);
      case "log": {
        if (this.log.some((e) => e.n === m.n)) return;
        this.log.push({ n: m.n, ...entryWithDefaults(await this._dec(m.entry, `log:${m.n}`)) });
        this.log.sort((a, b) => a.n - b.n);
        return this._emit("log", this.log, this.log.find((e) => e.n === m.n));
      }
      case "doc":
        if (this._ydoc) {
          (await this._yjs()).applyUpdate(this._ydoc, await this._decBytes(m.u, "doc"), "remote");
          this._docSeq = Math.max(this._docSeq, m.seq);
        }
        return;
      case "aw":
        return this._emit("presence", { from: m.from, data: m.d });
      case "version":
        return this._newVersion(m.hash);
      case "error":
        return console.warn("bantay:", m.error);
    }
  }

  _send(msg) {
    const rid = String(++this._rid);
    const text = JSON.stringify({ ...msg, rid });
    return new Promise((resolve, reject) => {
      this._pending.set(rid, { resolve, reject });
      if (this._ws?.readyState === 1 && this.status === "live") this._ws.send(text);
      else this._queue.push(text);
    });
  }

  _newVersion(hash) {
    if (this._listeners.get("version")?.size) return this._emit("version", hash);
    // Default: reload now if nothing is in flight, else at the next safe point.
    // An unpinned session opened at /<app>/v/<old> moves to the current URL
    // (reloading there would just load the old version again).
    const go = () => (location.pathname.includes("/v/") ? location.replace(`/${this.app}${location.search}`) : location.reload());
    const reloadWhenIdle = () => (this._pending.size ? setTimeout(reloadWhenIdle, 500) : go());
    ui.notice("A new version of this page is available.", "Reload", go);
    if (!this.dirty) reloadWhenIdle();
  }

  // --- public data API ------------------------------------------------------------

  /**
   * Save the state document. Pass an updater `(state) => next` (re-run on
   * conflict against the latest state) or a plain object (rejects on conflict).
   * Blank pages keep edits locally until the first save.
   */
  async save(next) {
    const updater = typeof next === "function" ? next : null;
    if (this.role === "blank") {
      this.state = stateWithDefaults(updater ? updater(clone(this.state)) : next);
      this.dirty = true;
      this._emit("state", this.state);
      ui.refresh();
      return this.stateVersion;
    }
    if (this.role !== "owner") throw new Error("read-only: unlock with the owner passcode to edit");
    for (let attempt = 0; attempt < 5; attempt++) {
      const value = updater ? updater(clone(this.state)) : next;
      const base = this.stateVersion;
      const r = await this._send({ t: "save", base, data: await this._enc(value, `state:${base + 1}`) });
      if (r.t === "saved") {
        this.stateVersion = r.v;
        this.state = stateWithDefaults(value);
        this._emit("state", this.state);
        return r.v;
      }
      // conflict: adopt the winner, then re-run the updater or give up
      this.stateVersion = r.v;
      this.state = stateWithDefaults(r.data == null ? {} : await this._dec(r.data, `state:${r.v}`));
      this._emit("state", this.state);
      if (!updater) throw new ConflictError("state changed on another device", { version: r.v, state: this.state });
    }
    throw new ConflictError("too many concurrent saves");
  }

  /**
   * Append to the numbered log. Claims number `n` (default: next). If someone
   * else already wrote that number, rejects with ConflictError({ head }) so the
   * caller can re-validate (e.g. a chess move against the new board).
   */
  async append(type, data, { n } = {}) {
    const entry = { type, data };
    if (this.role === "blank") {
      const num = this.log.length + 1;
      this.log.push({ n: num, ...entryWithDefaults(entry) });
      this.dirty = true;
      this._emit("log", this.log, this.log[num - 1]);
      ui.refresh();
      return num;
    }
    if (this.role !== "owner") throw new Error("read-only: unlock with the owner passcode to edit");
    const num = n ?? (this.log.at(-1)?.n ?? 0) + 1;
    const r = await this._send({ t: "append", n: num, entry: await this._enc(entry, `log:${num}`) });
    if (r.t === "rejected") throw new ConflictError(`log entry ${num} already taken`, { head: r.head });
    if (!this.log.some((e) => e.n === num)) {
      const added = { n: num, ...entryWithDefaults(entry) };
      this.log.push(added);
      this.log.sort((a, b) => a.n - b.n);
      this._emit("log", this.log, added);
    }
    return num;
  }

  /** Ephemeral presence/cursor data to everyone else on the page. Not stored. */
  presence(data) {
    if (this._ws?.readyState === 1 && this.status === "live") this._ws.send(JSON.stringify({ t: "aw", d: data }));
  }

  /** Shared Yjs document for mergeable data (chat, notes). Lazy-loads Yjs. */
  async doc() {
    if (this._ydoc) return this._ydoc;
    const Y = await this._yjs();
    this._ydoc = new Y.Doc();
    if (this._docRemote) await this._loadDoc(this._docRemote);
    this._ydoc.on("update", (u, origin) => {
      if (origin === "remote") return;
      if (this.role === "blank") { this.dirty = true; ui.refresh(); return; }
      if (this.role === "owner") this._sendDoc(u).catch((e) => console.warn("bantay doc:", e));
    });
    return this._ydoc;
  }

  _yjs() {
    return (this._Y ||= import("/_bantay/vendor/yjs.js"));
  }

  async _loadDoc(remote) {
    const Y = await this._yjs();
    if (remote.snapshot) Y.applyUpdate(this._ydoc, await this._decBytes(remote.snapshot, "doc"), "remote");
    for (const u of remote.updates) Y.applyUpdate(this._ydoc, await this._decBytes(u.u, "doc"), "remote");
    this._docSeq = remote.updates.at(-1)?.seq ?? remote.base;
    this._docSinceCompact = remote.updates.length;
  }

  async _sendDoc(update) {
    const r = await this._send({ t: "doc", u: await this._encBytes(update, "doc") });
    this._docSeq = Math.max(this._docSeq, r.seq);
    // Fold history into one snapshot now and then so loads stay small.
    if (++this._docSinceCompact >= 200) {
      this._docSinceCompact = 0;
      const Y = await this._yjs();
      const snapshot = await this._encBytes(Y.encodeStateAsUpdate(this._ydoc), "doc");
      this._send({ t: "doc-compact", upTo: this._docSeq, snapshot }).catch(() => {});
    }
  }
}

// --- built-in UI (shadow DOM, so page styles can't collide) ----------------------

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
.bar { position: fixed; right: 12px; bottom: 12px; z-index: 2147483000; display: flex; gap: 6px; align-items: center;
  background: #1c1b19; color: #f4f1ea; border-radius: 999px; padding: 6px 6px 6px 12px; box-shadow: 0 4px 18px rgba(0,0,0,.25); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #8a867d; }
.dot.live { background: #4caf7a; } .dot.connecting { background: #e0b44c; } .dot.offline { background: #d9534f; }
.label { white-space: nowrap; }
button { cursor: pointer; border: 0; border-radius: 999px; padding: 6px 12px; background: #f4f1ea; color: #1c1b19; font-weight: 600; }
button.ghost { background: transparent; color: inherit; border: 1px solid currentColor; }
button:disabled { opacity: .5; cursor: default; }
.menu { position: fixed; right: 12px; bottom: 58px; z-index: 2147483000; background: #fff; color: #1c1b19; border-radius: 12px;
  box-shadow: 0 8px 30px rgba(0,0,0,.2); padding: 6px; display: flex; flex-direction: column; min-width: 220px; }
.menu button { background: transparent; text-align: left; border-radius: 8px; font-weight: 500; }
.menu button:hover { background: #f1eee7; }
.scrim { position: fixed; inset: 0; z-index: 2147483001; background: rgba(20,19,17,.55); display: grid; place-items: center; padding: 16px; }
.dialog { background: #fff; color: #1c1b19; border-radius: 16px; padding: 20px; width: min(380px, 100%); box-shadow: 0 12px 40px rgba(0,0,0,.3); }
.dialog h2 { margin: 0 0 6px; font-size: 18px; font-weight: 700; }
.dialog p { margin: 0 0 12px; color: #55524b; }
.dialog label { display: block; margin: 10px 0 4px; font-weight: 600; }
.dialog input { width: 100%; padding: 10px 12px; border: 1px solid #cfcac0; border-radius: 10px; font-size: 16px; }
.dialog .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
.dialog button { background: #1c1b19; color: #fff; } .dialog button.ghost { background: transparent; color: #1c1b19; }
.err { color: #b3261e; min-height: 1.4em; margin-top: 8px; }
.qr { display: grid; place-items: center; margin: 8px 0; } .qr svg { width: 220px; height: 220px; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all;
  background: #f1eee7; padding: 8px; border-radius: 8px; display: block; }
.notice { position: fixed; left: 50%; transform: translateX(-50%); top: 12px; z-index: 2147483000; background: #1c1b19; color: #f4f1ea;
  padding: 8px 8px 8px 14px; border-radius: 999px; display: flex; gap: 10px; align-items: center; }
`;

const ui = {
  root: null,
  b: null,

  mount(b) {
    this.b = b;
    const host = document.createElement("bantay-ui");
    this.root = host.attachShadow({ mode: "open" });
    this.root.innerHTML = `<style>${CSS}</style><div class="bar" part="bar"></div>`;
    const attach = () => document.body.appendChild(host);
    document.body ? attach() : document.addEventListener("DOMContentLoaded", attach);
    b.on("role", () => this.refresh());
    b.on("status", () => this.refresh());
    this.refresh();
  },

  el(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  },

  refresh() {
    const b = this.b;
    const bar = this.root?.querySelector(".bar");
    if (!bar) return;
    const labels = {
      blank: b.dirty ? "Not saved" : "Draft",
      locked: "Locked",
      viewer: "View only",
      owner: "Owner",
    };
    const dot = b.role === "blank" ? "" : b.status;
    bar.innerHTML = `<span class="dot ${dot}"></span><span class="label" data-testid="bantay-role">${labels[b.role]}</span>`;
    const add = (text, fn, cls = "") => {
      const btn = this.el(`<button class="${cls}"></button>`);
      btn.textContent = text;
      btn.onclick = fn;
      bar.appendChild(btn);
    };
    if (b.role === "blank") add("Save", () => this.promptCreate());
    if (b.role === "locked") add("Unlock", () => this.promptUnlock(b));
    if (b.role === "viewer") add("Unlock to edit", () => this.promptUnlock(b));
    if (b.role === "viewer" || b.role === "owner") add("⋯", () => this.toggleMenu(), "ghost");
  },

  toggleMenu() {
    const existing = this.root.querySelector(".menu");
    if (existing) return existing.remove();
    const b = this.b;
    const menu = this.el(`<div class="menu"></div>`);
    const item = (text, fn) => {
      const btn = this.el(`<button></button>`);
      btn.textContent = text;
      btn.onclick = () => { menu.remove(); fn(); };
      menu.appendChild(btn);
    };
    item("Copy page link", () => navigator.clipboard.writeText(location.origin + location.pathname + "?id=" + b.id));
    if (b.role === "owner") {
      item("Pair a device (owner)", () => this.showPair("owner"));
      item("Pair a device (view only)", () => this.showPair("viewer"));
      if (b.enc === "none") item("Connect an LLM (MCP token)", () => this.showAgentToken());
      item("Sign out other devices", () => this.confirm("Sign out every other device?", "Other devices will need a passcode or pairing again.", () => b.revokeOthers()));
    }
    item("Sign out this device", () => b.signOut());
    this.root.appendChild(menu);
  },

  dialog(html) {
    this.root.querySelector(".scrim")?.remove();
    const scrim = this.el(`<div class="scrim"><div class="dialog" role="dialog" aria-modal="true">${html}</div></div>`);
    this.root.appendChild(scrim);
    const close = () => scrim.remove();
    scrim.querySelector("[data-close]")?.addEventListener("click", close);
    scrim.querySelector("input")?.focus();
    return { scrim, close, $: (s) => scrim.querySelector(s) };
  },

  promptUnlock(b, { keyOnly = false } = {}) {
    const d = this.dialog(`
      <form>
        <h2>${keyOnly ? "Enter a passcode for this device" : b.role === "viewer" ? "Unlock editing" : "This page is locked"}</h2>
        <p>${keyOnly ? "This device is signed in but needs a passcode to decrypt the page." : "Enter the view or owner passcode."}</p>
        <input type="password" autocomplete="current-password" data-testid="bantay-passcode" aria-label="Passcode" required>
        <div class="err" aria-live="polite"></div>
        <div class="row">${b.role === "viewer" ? `<button type="button" class="ghost" data-close>Cancel</button>` : ""}<button type="submit">Unlock</button></div>
      </form>`);
    d.$("form").onsubmit = async (e) => {
      e.preventDefault();
      const btn = d.$("button[type=submit]");
      btn.disabled = true;
      btn.textContent = "Checking…";
      d.$(".err").textContent = "";
      try {
        await b.unlock(d.$("input").value, { keyOnly });
        d.close();
      } catch (err) {
        const left = err.data?.attemptsLeft;
        d.$(".err").textContent =
          err.status === 429 ? `Too many attempts. Try again in ${err.data?.retryAfter}s.`
          : err.status === 403 ? `Wrong passcode.${left != null && left <= 3 ? ` ${left} attempt(s) before a lockout.` : ""}`
          : err.message;
        btn.disabled = false;
        btn.textContent = "Unlock";
      }
    };
  },

  offerRedeem(b, fragment, isPair) {
    const d = this.dialog(`
      <h2>${isPair ? "Pair this device" : "Claim owner access"}</h2>
      <p>${isPair ? "A trusted device invited this one. Tap to join." : "An administrator issued a recovery link for this page."}</p>
      <div class="err"></div>
      <div class="row"><button type="button" class="ghost" data-close>Not now</button><button type="button" data-testid="bantay-redeem">${isPair ? "Pair" : "Claim"}</button></div>`);
    d.$("[data-close]").addEventListener("click", () => {
      history.replaceState(null, "", location.pathname + location.search);
      this.promptUnlock(b);
    });
    d.$("[data-testid=bantay-redeem]").onclick = async () => {
      try {
        d.close();
        await b.redeem(fragment);
      } catch (err) {
        this.dialog(`<h2>Couldn't pair</h2><p></p><div class="row"><button data-close>OK</button></div>`).$("p").textContent =
          err.status === 410 ? "This link has expired or was already used. Ask for a new one." : err.message;
        history.replaceState(null, "", location.pathname + location.search);
      }
    };
  },

  promptCreate() {
    const b = this.b;
    const d = this.dialog(`
      <form>
        <h2>Save this page</h2>
        <p>Set two passcodes. Share the <b>view</b> passcode with people who should see it; keep the <b>owner</b> passcode for people who edit.</p>
        <label for="vp">View passcode</label>
        <input id="vp" type="password" autocomplete="new-password" minlength="6" required data-testid="bantay-view-pass">
        <label for="op">Owner passcode</label>
        <input id="op" type="password" autocomplete="new-password" minlength="6" required data-testid="bantay-owner-pass">
        <div class="err" aria-live="polite"></div>
        <div class="row"><button type="button" class="ghost" data-close>Cancel</button><button type="submit">Save</button></div>
      </form>`);
    d.$("form").onsubmit = async (e) => {
      e.preventDefault();
      const [vp, op] = [d.$("#vp").value, d.$("#op").value];
      if (vp === op) return (d.$(".err").textContent = "Use two different passcodes.");
      const btn = d.$("button[type=submit]");
      btn.disabled = true;
      btn.textContent = "Saving…";
      try {
        await b.create(vp, op);
        d.close();
        this.refresh();
      } catch (err) {
        d.$(".err").textContent = err.message;
        btn.disabled = false;
        btn.textContent = "Save";
      }
    };
  },

  async showPair(role) {
    const b = this.b;
    const { url, expires } = await b.pairLink(role);
    const qr = (await import("/_bantay/vendor/qr.js")).default(0, "M");
    qr.addData(url);
    qr.make();
    const d = this.dialog(`
      <h2>Pair a device ${role === "viewer" ? "(view only)" : "(owner)"}</h2>
      <p>Scan with the new device's camera, then tap <b>Pair</b> there. Works once.</p>
      <div class="qr">${qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}</div>
      <p class="expires"></p>
      <code class="mono" data-testid="bantay-pair-url"></code>
      <div class="row"><button data-close>Done</button></div>`);
    d.$(".mono").textContent = url;
    const tick = () => {
      if (!d.scrim.isConnected) return;
      const s = Math.max(0, Math.round((expires - Date.now()) / 1000));
      d.$(".expires").textContent = s ? `Expires in ${s}s.` : "Expired. Close and try again.";
      if (s) setTimeout(tick, 1000);
    };
    tick();
  },

  async showAgentToken() {
    const token = await this.b.agentToken();
    const d = this.dialog(`
      <h2>Connect an LLM</h2>
      <p>Give an MCP client this endpoint, session ID and token. It can read and edit this page until you sign out other devices.</p>
      <label>MCP endpoint</label><code class="mono ep"></code>
      <label>Session ID</label><code class="mono sid"></code>
      <label>Token</label><code class="mono tok" data-testid="bantay-agent-token"></code>
      <div class="row"><button data-close>Done</button></div>`);
    d.$(".ep").textContent = location.origin + "/mcp";
    d.$(".sid").textContent = this.b.id;
    d.$(".tok").textContent = token;
  },

  confirm(title, text, fn) {
    const d = this.dialog(`<h2></h2><p></p><div class="row"><button class="ghost" data-close>Cancel</button><button data-ok>Confirm</button></div>`);
    d.$("h2").textContent = title;
    d.$("p").textContent = text;
    d.$("[data-ok]").onclick = async () => { d.close(); await fn(); };
  },

  notice(text, action, fn) {
    this.root.querySelector(".notice")?.remove();
    const n = this.el(`<div class="notice"><span></span><button></button></div>`);
    n.querySelector("span").textContent = text;
    n.querySelector("button").textContent = action;
    n.querySelector("button").onclick = fn;
    this.root.appendChild(n);
  },
};

export const bantay = new Bantay();
window.bantay = bantay;
export default bantay;
