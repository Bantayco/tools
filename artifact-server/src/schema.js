// Session-data schemas: add-only, proto-style.
//
// Each published page version declares its schema in the HTML:
//
//   <script type="application/json" id="bantay-schema">
//   {
//     "encryption": "e2e",                      // or "none" (MCP-editable)
//     "state": {
//       "title":   { "type": "string", "default": "" },
//       "players": { "type": "array",  "default": [] },
//       "oldName": { "type": "string", "default": "", "deprecated": true }
//     },
//     "log": {
//       "pick": { "fields": { "player": { "type": "string", "default": "" } } }
//     }
//   }
//   </script>
//
// The server never reads session data (it may be ciphertext), so it enforces
// the rules here, at publish time, by diffing declared schemas:
//   - fields are only added; never removed, renamed (= removed) or retyped
//   - every field declares a default (matching its type)
//   - deprecated fields stay listed forever and are never un-deprecated
//   - log entry types follow the same rules, field by field

export const TYPES = ["string", "number", "boolean", "object", "array", "map", "any"];
export const ENCRYPTION = ["e2e", "none"];
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export const EMPTY_SCHEMA = Object.freeze({ encryption: "e2e", state: {}, log: {} });

/** Pull the declared schema out of a page's HTML. No tag = empty schema. */
export function extractSchema(html) {
  const m = /<script\b[^>]*\bid=["']bantay-schema["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) return { schema: structuredClone(EMPTY_SCHEMA), errors: [] };
  let raw;
  try {
    raw = JSON.parse(m[1]);
  } catch (e) {
    return { schema: null, errors: ["schema: invalid JSON (" + e.message + ")"] };
  }
  return normalize(raw);
}

function typeMatches(type, v) {
  switch (type) {
    case "any": return true;
    case "string": return typeof v === "string";
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "boolean": return typeof v === "boolean";
    case "array": return Array.isArray(v);
    case "object":
    case "map": return v !== null && typeof v === "object" && !Array.isArray(v);
  }
  return false;
}

function normalizeFields(fields, where, errors) {
  const out = {};
  if (fields == null) return out;
  if (typeof fields !== "object" || Array.isArray(fields)) {
    errors.push(`${where}: must be an object of fields`);
    return out;
  }
  for (const [name, f] of Object.entries(fields)) {
    const at = `${where}.${name}`;
    if (!NAME.test(name)) { errors.push(`${at}: invalid field name`); continue; }
    if (!f || typeof f !== "object") { errors.push(`${at}: must be an object`); continue; }
    if (!TYPES.includes(f.type)) { errors.push(`${at}: type must be one of ${TYPES.join(", ")}`); continue; }
    if (!("default" in f)) { errors.push(`${at}: missing default`); continue; }
    if (!typeMatches(f.type, f.default)) { errors.push(`${at}: default does not match type ${f.type}`); continue; }
    out[name] = { type: f.type, default: f.default, ...(f.deprecated ? { deprecated: true } : {}) };
  }
  return out;
}

/** Validate shape + defaults of a single schema. Returns { schema, errors }. */
export function normalize(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { schema: null, errors: ["schema: must be an object"] };
  const encryption = raw.encryption ?? "e2e";
  if (!ENCRYPTION.includes(encryption)) errors.push(`encryption: must be one of ${ENCRYPTION.join(", ")}`);
  const state = normalizeFields(raw.state, "state", errors);
  const log = {};
  if (raw.log != null) {
    if (typeof raw.log !== "object" || Array.isArray(raw.log)) errors.push("log: must be an object of entry types");
    else for (const [type, def] of Object.entries(raw.log)) {
      if (!NAME.test(type)) { errors.push(`log.${type}: invalid entry type name`); continue; }
      if (!def || typeof def !== "object") { errors.push(`log.${type}: must be an object`); continue; }
      log[type] = { fields: normalizeFields(def.fields, `log.${type}.fields`, errors), ...(def.deprecated ? { deprecated: true } : {}) };
    }
  }
  return { schema: errors.length ? null : { encryption, state, log }, errors };
}

function diffFields(prev, next, where, errors) {
  for (const [name, p] of Object.entries(prev)) {
    const n = next[name];
    const at = `${where}.${name}`;
    if (!n) { errors.push(`${at}: removed (fields are add-only; mark it deprecated instead)`); continue; }
    if (n.type !== p.type) errors.push(`${at}: retyped ${p.type} -> ${n.type}`);
    if (p.deprecated && !n.deprecated) errors.push(`${at}: un-deprecated (retired names are never reused)`);
  }
}

/**
 * Breaking changes going from `prev` to `next` (both normalized).
 * Empty array = compatible. Encryption may change: it only applies to
 * sessions created afterwards (each session fixes its mode at creation).
 */
export function diffSchemas(prev, next) {
  const errors = [];
  diffFields(prev.state, next.state, "state", errors);
  for (const [type, p] of Object.entries(prev.log)) {
    const n = next.log[type];
    if (!n) { errors.push(`log.${type}: entry type removed (mark it deprecated instead)`); continue; }
    if (p.deprecated && !n.deprecated) errors.push(`log.${type}: un-deprecated (retired names are never reused)`);
    diffFields(p.fields, n.fields, `log.${type}.fields`, errors);
  }
  return errors;
}
