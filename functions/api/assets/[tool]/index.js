// GET /api/assets/:tool  -> the current user's saved items for ONE tool.
import { json, sanitizeSlug } from "../../_lib.js";

export async function onRequestGet({ env, data, params }) {
  const tool = sanitizeSlug(params.tool);
  if (!tool) return json({ error: "Bad tool" }, 400);

  const { results } = await env.DB.prepare(
    "SELECT slug, title, updated_at AS updatedAt FROM items WHERE user_id = ? AND tool = ? ORDER BY updated_at DESC"
  )
    .bind(data.userId, tool)
    .all();
  return json({ items: results });
}
