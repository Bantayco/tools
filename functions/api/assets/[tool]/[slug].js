// Per-item CRUD for one tool, scoped to the authenticated user.
// Stored in D1, keyed by (user_id, tool, slug).
import { json, sanitizeSlug } from "../../_lib.js";

const MAX_BYTES = 100_000;

function keyFor(params) {
  return { tool: sanitizeSlug(params.tool), slug: sanitizeSlug(params.slug) };
}

export async function onRequestGet({ env, data, params }) {
  const { tool, slug } = keyFor(params);
  if (!tool || !slug) return json({ error: "Bad request" }, 400);

  const row = await env.DB.prepare(
    "SELECT data FROM items WHERE user_id = ? AND tool = ? AND slug = ?"
  )
    .bind(data.userId, tool, slug)
    .first();
  if (!row) return json({ error: "Not found" }, 404);
  return new Response(row.data, {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function onRequestPut({ request, env, data, params }) {
  const { tool, slug } = keyFor(params);
  if (!tool || !slug) return json({ error: "Bad request" }, 400);

  const body = await request.text();
  if (body.length > MAX_BYTES) return json({ error: "Too large" }, 413);

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const title = parsed.title || parsed.brandName || slug;
  const updatedAt = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO items (user_id, tool, slug, title, data, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, tool, slug)
     DO UPDATE SET title = excluded.title, data = excluded.data, updated_at = excluded.updated_at`
  )
    .bind(data.userId, tool, slug, title, JSON.stringify(parsed), updatedAt)
    .run();

  return json({ ok: true, slug });
}

export async function onRequestDelete({ env, data, params }) {
  const { tool, slug } = keyFor(params);
  if (!tool || !slug) return json({ error: "Bad request" }, 400);

  await env.DB.prepare(
    "DELETE FROM items WHERE user_id = ? AND tool = ? AND slug = ?"
  )
    .bind(data.userId, tool, slug)
    .run();
  return json({ ok: true });
}
