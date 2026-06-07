// GET /api/assets  -> every saved item for the current user, ACROSS all tools.
// Powers the root dashboard. D1 is strongly consistent, so a just-saved item
// shows up immediately.
import { json } from "../_lib.js";

export async function onRequestGet({ env, data }) {
  const { results } = await env.DB.prepare(
    "SELECT tool, slug, title, updated_at AS updatedAt FROM items WHERE user_id = ? ORDER BY updated_at DESC"
  )
    .bind(data.userId)
    .all();
  return json({ items: results });
}
