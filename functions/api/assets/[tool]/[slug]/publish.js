// Publish state for one saved item, scoped to the authenticated owner.
//   GET    -> { publishedAt, publicUrl } or null
//   POST   -> snapshot current data/title into the published_* columns
//   DELETE -> clear the snapshot (unpublish)
// The public read endpoint lives at /public/<tool>/<slug>, outside /api/, so it
// isn't gated by _middleware.js.
import { json, sanitizeSlug } from "../../../_lib.js";

function keyFor(params) {
  return { tool: sanitizeSlug(params.tool), slug: sanitizeSlug(params.slug) };
}

function publicUrl(tool, slug) {
  return `/public/${tool}/${slug}`;
}

export async function onRequestGet({ env, data, params }) {
  const { tool, slug } = keyFor(params);
  if (!tool || !slug) return json({ error: "Bad request" }, 400);

  const row = await env.DB.prepare(
    "SELECT published_at FROM items WHERE user_id = ? AND tool = ? AND slug = ?"
  )
    .bind(data.userId, tool, slug)
    .first();
  if (!row) return json({ error: "Not found" }, 404);
  if (!row.published_at) return json(null);
  return json({ publishedAt: row.published_at, publicUrl: publicUrl(tool, slug) });
}

export async function onRequestPost({ env, data, params }) {
  const { tool, slug } = keyFor(params);
  if (!tool || !slug) return json({ error: "Bad request" }, 400);

  const row = await env.DB.prepare(
    "SELECT data, title FROM items WHERE user_id = ? AND tool = ? AND slug = ?"
  )
    .bind(data.userId, tool, slug)
    .first();
  if (!row) return json({ error: "Not found" }, 404);

  const publishedAt = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE items
       SET published_data = ?, published_title = ?, published_at = ?
     WHERE user_id = ? AND tool = ? AND slug = ?`
  )
    .bind(row.data, row.title, publishedAt, data.userId, tool, slug)
    .run();

  return json({ ok: true, publishedAt, publicUrl: publicUrl(tool, slug) });
}

export async function onRequestDelete({ env, data, params }) {
  const { tool, slug } = keyFor(params);
  if (!tool || !slug) return json({ error: "Bad request" }, 400);

  await env.DB.prepare(
    `UPDATE items
       SET published_data = NULL, published_title = NULL, published_at = NULL
     WHERE user_id = ? AND tool = ? AND slug = ?`
  )
    .bind(data.userId, tool, slug)
    .run();
  return json({ ok: true });
}
