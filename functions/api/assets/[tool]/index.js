// GET /api/assets/:tool  -> list the current user's saved items for ONE tool.
// Keys are namespaced "<userId>:<tool>:<slug>" so tools never see each other's
// saves and slugs can't collide across tools.
import { json, sanitizeSlug } from "../../_lib.js";

export async function onRequestGet({ env, data, params }) {
  const tool = sanitizeSlug(params.tool);
  if (!tool) return json({ error: "Bad tool" }, 400);

  const prefix = `${data.userId}:${tool}:`;
  const list = await env.GUIDES.list({ prefix });
  const items = list.keys.map((k) => ({
    slug: k.name.slice(prefix.length),
    ...(k.metadata || {}),
  }));
  return json({ items });
}
