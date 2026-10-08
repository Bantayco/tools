// Read-only public view of a published item. NO AUTHENTICATION.
// Placed outside /api/ so functions/api/_middleware.js does not run.
//   GET /public/<tool>/<slug> -> { title, data, publishedAt } | 404
// `data` is the raw JSON payload the owner published; the calling tool page
// decides how to render it. Only rows with published_at IS NOT NULL are visible.

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
    },
  });
}

function sanitizeSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 63);
}

export async function onRequestGet({ env, params }) {
  const tool = sanitizeSlug(params.tool);
  const slug = sanitizeSlug(params.slug);
  if (!tool || !slug) return json({ error: "Bad request" }, 400);

  const row = await env.DB.prepare(
    `SELECT published_title AS title, published_data AS data, published_at AS publishedAt
       FROM items
      WHERE tool = ? AND slug = ? AND published_at IS NOT NULL
      LIMIT 1`
  )
    .bind(tool, slug)
    .first();
  if (!row) return json({ error: "Not found" }, 404);

  let payload;
  try {
    payload = JSON.parse(row.data);
  } catch {
    return json({ error: "Corrupt payload" }, 500);
  }

  return json({
    title: row.title || slug,
    data: payload,
    publishedAt: row.publishedAt,
  });
}
