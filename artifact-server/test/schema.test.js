import test from "node:test";
import assert from "node:assert/strict";
import { extractSchema, diffSchemas, normalize } from "../src/schema.js";

const page = (schema) => `<html><head><script type="application/json" id="bantay-schema">${JSON.stringify(schema)}</script></head></html>`;
const norm = (raw) => normalize(raw).schema;

test("missing tag = empty e2e schema", () => {
  const { schema, errors } = extractSchema("<html></html>");
  assert.deepEqual(errors, []);
  assert.deepEqual(schema, { encryption: "e2e", state: {}, log: {} });
});

test("extracts and validates a schema", () => {
  const { schema, errors } = extractSchema(page({ encryption: "none", state: { a: { type: "string", default: "" } } }));
  assert.deepEqual(errors, []);
  assert.equal(schema.encryption, "none");
  assert.deepEqual(schema.state.a, { type: "string", default: "" });
});

test("every field needs a default matching its type", () => {
  assert.match(normalize({ state: { a: { type: "string" } } }).errors[0], /missing default/);
  assert.match(normalize({ state: { a: { type: "number", default: "1" } } }).errors[0], /does not match/);
  assert.match(normalize({ state: { a: { type: "map", default: [] } } }).errors[0], /does not match/);
  assert.match(normalize({ state: { a: { type: "date", default: 1 } } }).errors[0], /type must be/);
  assert.match(normalize({ encryption: "rot13" }).errors[0], /encryption/);
  assert.match(extractSchema('<script id="bantay-schema">{nope</script>').errors[0], /invalid JSON/);
});

test("adding fields and entry types is compatible", () => {
  const a = norm({ state: { a: { type: "string", default: "" } } });
  const b = norm({ state: { a: { type: "string", default: "" }, b: { type: "array", default: [] } }, log: { move: { fields: { to: { type: "string", default: "" } } } } });
  assert.deepEqual(diffSchemas(a, b), []);
});

test("removing, retyping, un-deprecating are breaking", () => {
  const log = { move: { fields: { to: { type: "string", default: "" } } } };
  const old = { type: "number", default: 0, deprecated: true };
  const a = norm({ state: { a: { type: "string", default: "" }, old }, log });
  assert.match(diffSchemas(a, norm({ state: { old }, log })).join(), /state\.a: removed/);
  assert.match(diffSchemas(a, norm({ state: { a: { type: "number", default: 0 }, old }, log })).join(), /retyped string -> number/);
  assert.match(diffSchemas(a, norm({ state: { a: { type: "string", default: "" }, old: { type: "number", default: 0 } }, log })).join(), /un-deprecated/);
  assert.match(diffSchemas(a, norm({ state: { a: { type: "string", default: "" }, old } })).join(), /log\.move: entry type removed/);
  assert.match(diffSchemas(a, norm({ state: { a: { type: "string", default: "" }, old }, log: { move: { fields: {} } } })).join(), /log\.move\.fields\.to: removed/);
});

test("deprecating a field is compatible; encryption may change", () => {
  const a = norm({ state: { a: { type: "string", default: "" } } });
  const b = norm({ encryption: "none", state: { a: { type: "string", default: "", deprecated: true } } });
  assert.deepEqual(diffSchemas(a, b), []);
});
