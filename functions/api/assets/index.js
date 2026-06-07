// GET /api/assets  -> every saved item for the current user, ACROSS all tools.
// Powers the root dashboard. Keys are "<userId>:<tool>:<slug>"; we strip the
// userId prefix by length (the userId may itself contain ":"), then split the
// remainder on its first ":" since tool/slug are [a-z0-9-] only.
import { json } from "../_lib.js";

export async function onRequestGet({ env, data }) {
  const prefix = `${data.userId}:`;
  const items = [];
  let cursor;

  do {
    const page = await env.GUIDES.list({ prefix, cursor });
    for (const k of page.keys) {
      const rest = k.name.slice(prefix.length); // "<tool>:<slug>"
      const i = rest.indexOf(":");
      if (i === -1) continue; // skip any legacy un-namespaced keys
      items.push({
        tool: rest.slice(0, i),
        slug: rest.slice(i + 1),
        ...(k.metadata || {}),
      });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  return json({ items });
}
