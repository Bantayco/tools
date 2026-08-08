// affiliate.js — build search URLs to the three big retailers, plus optional
// affiliate tagging when the user has one configured.
//
// buildLinks(spec, settings) -> { homeDepot, lowes, amazon }
// Any that would be empty (no useful query) return an empty string.

export function buildLinks(spec, settings = {}) {
  const q = query(spec);
  if (!q) return { homeDepot: "", lowes: "", amazon: "" };

  return {
    homeDepot: hd(q, settings.homeDepotTag),
    lowes:     lowes(q, settings.lowesTag),
    amazon:    amazon(q, settings.amazonTag),
  };
}

function query(s) {
  const bits = [];
  if (s.size) bits.push(s.size);
  if (s.length) bits.push(s.length);
  if (s.head && s.head.toLowerCase() !== "none") bits.push(s.head);
  if (s.drive && s.drive.toLowerCase() !== "none") bits.push(s.drive);
  if (s.subtype) bits.push(s.subtype);
  if (s.category) bits.push(s.category);
  if (s.finish) bits.push(s.finish);
  else if (s.material) bits.push(s.material);
  return bits
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function enc(s) { return encodeURIComponent(s); }

function hd(q, tag) {
  const u = new URL("https://www.homedepot.com/s/" + enc(q));
  // Home Depot works with CJ / Impact links — the tag we accept here is just
  // an opaque token we forward on the outbound URL. If you have a real
  // deep-link tool, use it upstream; this at least preserves the ID.
  if (tag) u.searchParams.set("affid", tag);
  return u.toString();
}

function lowes(q, tag) {
  const u = new URL("https://www.lowes.com/search");
  u.searchParams.set("searchTerm", q);
  if (tag) u.searchParams.set("cm_mmc", tag);
  return u.toString();
}

function amazon(q, tag) {
  const u = new URL("https://www.amazon.com/s");
  u.searchParams.set("k", q);
  // "Tools & Home Improvement" node — narrows results to actual hardware
  u.searchParams.set("i", "tools");
  if (tag) u.searchParams.set("tag", tag);
  return u.toString();
}
