// Per-item CRUD for one tool, scoped to the authenticated user.
// Key: "<userId>:<tool>:<slug>".
import { json, sanitizeSlug } from "../../_lib.js";

const MAX_BYTES = 100_000;

function keyFor(data, params) {
  const tool = sanitizeSlug(params.tool);
  const slug = sanitizeSlug(params.slug);
  if (!tool || !slug) return { slug: "", key: "" };
  return { slug, key: `${data.userId}:${tool}:${slug}` };
}

export async function onRequestGet({ env, data, params }) {
  const { key } = keyFor(data, params);
  if (!key) return json({ error: "Bad request" }, 400);
  const value = await env.GUIDES.get(key);
  if (value === null) return json({ error: "Not found" }, 404);
  return new Response(value, {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function onRequestPut({ request, env, data, params }) {
  const { slug, key } = keyFor(data, params);
  if (!key) return json({ error: "Bad request" }, 400);

  const body = await request.text();
  if (body.length > MAX_BYTES) return json({ error: "Too large" }, 413);

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  await env.GUIDES.put(key, JSON.stringify(parsed), {
    metadata: {
      title: parsed.title || parsed.brandName || slug,
      updatedAt: new Date().toISOString(),
    },
  });
  return json({ ok: true, slug });
}

export async function onRequestDelete({ env, data, params }) {
  const { key } = keyFor(data, params);
  if (!key) return json({ error: "Bad request" }, 400);
  await env.GUIDES.delete(key);
  return json({ ok: true });
}
