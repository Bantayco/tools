// POST /api/fastenaiting/identify
//
// Body: { image?: base64, mediaType?: "image/jpeg", text?: string }
// Auth: none (this endpoint is listed as public in api/_middleware.js).
//
// Uses Anthropic Claude vision to identify a fastener from a photo (or from a
// text description) and returns a normalized spec object the front-end fills
// into its form.
//
// Server-side key precedence:
//   env.ANTHROPIC_API_KEY (Pages secret)   ← primary, no BYOK needed
//   x-user-api-key request header          ← BYOK fallback
// If neither is set the function responds 501 so the UI can prompt for a key.

import { json } from "../_lib.js";

const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 700;

const SYSTEM = `You identify hardware fasteners (screws, bolts, nuts, washers, anchors, rivets, nails).
Return a SINGLE JSON object only — no markdown, no prose, no code fences.
Use these keys (all optional; omit or empty-string if not visible):
  category   one of: Screw, Bolt, Nut, Washer, Anchor, Rivet, Nail, Other
  subtype    e.g. "Wood", "Machine", "Sheet metal", "Deck", "Lag", "Hex", "Cap", "Flat"
  head       one of: Pan, Flat (countersunk), Oval, Round, Truss, Button, Hex, Socket cap, Bugle, None
  drive      one of: Phillips, Slotted, Pozidriv, Torx, Square (Robertson), Hex (Allen), External hex, Combination, None
  thread     one of: Coarse, Fine, Machine, Wood, Self-tapping, Sheet metal, None
  standard   one of: sae, metric
  size       diameter or gauge string, e.g. "#8", "1/4\\"", "M6"
  length     length string, e.g. "1\\"", "1 1/4\\"", "25mm"
  pitch      thread pitch or TPI, e.g. "1.0", "20 tpi"
  material   one of: Steel, Stainless, Brass, Aluminum, Nylon, Zinc, Copper
  finish     one of: Zinc-plated, Black oxide, Bright, Chrome, Galvanized, Painted, Unfinished
  color      short color word, e.g. "silver", "black", "brass"
  notes      short free-text (< 80 chars) if useful
Prefer common consumer specs. If uncertain, pick the most likely value rather than leaving it blank —
users can edit any field. Never invent measurements; only estimate if a reference object is in frame.`;

const USER_INSTRUCTION = "Identify this fastener. Reply with only the JSON object.";
const USER_INSTRUCTION_TEXT = (text) =>
  `Identify the fastener described here and reply with only the JSON object.\n\nDescription: ${text}`;

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const apiKey =
    env.ANTHROPIC_API_KEY ||
    request.headers.get("x-user-api-key") ||
    "";
  if (!apiKey) {
    return json({ error: "No Anthropic API key configured." }, 501);
  }

  const hasImage = typeof body.image === "string" && body.image.length > 100;
  const hasText  = typeof body.text  === "string" && body.text.trim().length > 0;
  if (!hasImage && !hasText) {
    return json({ error: "Provide an image or a text description." }, 400);
  }

  // Compose the content block.
  const content = [];
  if (hasImage) {
    const mediaType = allowedMedia(body.mediaType) || "image/jpeg";
    content.push({
      type: "image",
      source: { type: "base64", media_type: mediaType, data: body.image },
    });
    content.push({ type: "text", text: USER_INSTRUCTION });
  } else {
    content.push({ type: "text", text: USER_INSTRUCTION_TEXT(body.text) });
  }

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      messages: [{ role: "user", content }],
    }),
  });

  if (!upstream.ok) {
    let detail;
    try { detail = await upstream.json(); } catch { detail = { error: upstream.statusText }; }
    return json({ error: "Upstream vision call failed", detail }, upstream.status);
  }

  const payload = await upstream.json();
  const text = (payload.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  const parsed = safeJson(text);
  if (!parsed) {
    return json({ error: "Model did not return JSON.", raw: text }, 502);
  }
  return json(normalize(parsed));
}

function allowedMedia(t) {
  const ok = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  return ok.includes(t) ? t : null;
}

// Pull the first {...} block out of the model's text and JSON.parse it.
function safeJson(text) {
  if (!text) return null;
  // Strip common code fences.
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(stripped); } catch {}
  const m = stripped.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// Coerce shape / trim string values.
function normalize(o) {
  const keys = [
    "category","subtype","head","drive","thread","standard",
    "size","length","pitch","material","finish","color","notes",
  ];
  const out = {};
  for (const k of keys) {
    const v = o[k];
    if (v == null) continue;
    out[k] = typeof v === "string" ? v.trim() : String(v);
  }
  return out;
}
