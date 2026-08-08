// scripts/aide-lock.mjs
//
// Read an aidefile (YAML), emit a canonicalized aide.lock beside it.
//
// The lock is the committed snapshot the Bantay diff engine reads to classify
// the next aide edit. Its properties:
//   • Deterministic — identical input produces byte-identical output.
//   • Grouped — entities are grouped by kind (cuj/scenario/invariant/…)
//     because the loop each change triggers depends on kind.
//   • Hashed — per-entity sha256 lets a downstream diff engine tell "same"
//     from "changed" without deep-parsing.
//   • Human-readable — the git diff on this file is the auditable record of
//     what changed and what didn't.
//
// Usage:
//   node scripts/aide-lock.mjs <aide-file>
//   node scripts/aide-lock.mjs fastenaiting/fastenaiting.aide
//   npm run lock          # runs all aides in the repo
//
// Non-goals: this script does NOT decide what loop to trigger from a diff.
// That's the job of the (future) diff classifier. This script's only job is
// to produce a stable snapshot the classifier can read.

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { createHash } from "crypto";
import { dirname, join, relative } from "path";
import { load, dump } from "js-yaml";

const LOCK_VERSION = 1;
const GENERATOR = { name: "aide-lock", version: "0.1.0" };

// ---- canonical serialization -------------------------------------------
// Deterministic key ordering + JSON.stringify for the hash payload.
// Arrays keep their author-declared order (`then` steps, `sc_` ordering under
// a CUJ, and the relationship list are all semantically ordered).
function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}
function sha256(s) { return createHash("sha256").update(s).digest("hex"); }

// ---- kind inference ----------------------------------------------------
// The aide schema is loose (any entity, any parent), but a few container
// names have well-known kinds. Scenarios are inferred by "parent is a cuj".
const CONTAINER_KIND = {
  cujs: "cuj",
  invariants: "invariant",
  constraints: "constraint",
  foundations: "foundation",
  wisdom: "wisdom",
};

function kindOf(id, entities) {
  const e = entities[id];
  if (!e) return "unknown";
  if (CONTAINER_KIND[id]) return "container";
  if (e.display === "page") return "page";
  const parent = e.parent;
  if (CONTAINER_KIND[parent]) return CONTAINER_KIND[parent];
  // If parent is a cuj, this is a scenario.
  if (parent && entities[parent] && CONTAINER_KIND[entities[parent].parent] === "cuj") {
    return "scenario";
  }
  return "entity";
}

// ---- build the lock ----------------------------------------------------
function buildLock(aidePath, src) {
  const doc = load(src);
  if (!doc || typeof doc !== "object") throw new Error("empty or invalid YAML");

  const entities = doc.entities || {};
  const rels = Array.isArray(doc.relationships) ? doc.relationships : [];

  // Group entities by kind, skipping the pure layout scaffolding (page + the
  // named containers). The lock is about the CONTENT, not the presentation.
  const grouped = {};
  for (const [id, e] of Object.entries(entities)) {
    const kind = kindOf(id, entities);
    if (kind === "container" || kind === "page") continue;
    const record = {
      parent: e.parent,
      props: sortObj(e.props || {}),
    };
    record.sha256 = sha256(canonical({ kind, ...record }));
    (grouped[kind] ??= {})[id] = record;
  }
  // Stable id order within each kind so the diff is meaningful.
  for (const k of Object.keys(grouped)) {
    grouped[k] = Object.fromEntries(
      Object.keys(grouped[k]).sort().map((id) => [id, grouped[k][id]])
    );
  }

  // Relationships: normalize each one, then sort by (type, from, to) so
  // additions/removals show up cleanly in the diff.
  const relRecs = rels.map((r) => {
    const rec = {
      from: r.from, to: r.to, type: r.type,
      ...(r.cardinality ? { cardinality: r.cardinality } : {}),
    };
    rec.sha256 = sha256(canonical(rec));
    return rec;
  });
  relRecs.sort((a, b) =>
    a.type.localeCompare(b.type) ||
    a.from.localeCompare(b.from) ||
    a.to.localeCompare(b.to)
  );

  const summary = Object.fromEntries(
    Object.entries(grouped).map(([k, v]) => [k + "s", Object.keys(v).length])
  );
  summary.relationships = relRecs.length;

  const root = Object.keys(entities).find((id) => entities[id].display === "page");
  const rootProps = root ? entities[root].props || {} : {};

  return {
    lock_version: LOCK_VERSION,
    generator: GENERATOR,
    source: {
      file: relative(process.cwd(), aidePath).replace(/\\/g, "/"),
      sha256: sha256(src),
    },
    aide: {
      id: root,
      title: rootProps.title ?? null,
      version: rootProps.version ?? null,
    },
    summary,
    entities: grouped,
    relationships: relRecs,
  };
}

function sortObj(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

// ---- write ------------------------------------------------------------
function writeLock(aidePath, lock) {
  const outPath = join(dirname(aidePath), "aide.lock");
  const banner =
    "# aide.lock — canonical snapshot of the aidefile.\n" +
    "# GENERATED — do not hand-edit. Regenerate on every aide change with:\n" +
    `#   node scripts/aide-lock.mjs ${lock.source.file}\n` +
    "#\n" +
    "# The diff on this file is the auditable record of what actually changed\n" +
    "# in the behavioral spec — new scenarios, modified invariants, moved\n" +
    "# constraints. CI compares (aide, lock) to reject drift in either\n" +
    "# direction: an aide edit without a lock update, or a lock update that\n" +
    "# doesn't match its aide.\n\n";
  const body = dump(lock, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,      // we've already ordered them semantically
    quotingType: '"',
    forceQuotes: false,
  });
  writeFileSync(outPath, banner + body);
  return outPath;
}

// ---- discovery --------------------------------------------------------
function findAides(root) {
  const out = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".") || name === "test-results") continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (name.endsWith(".aide")) out.push(full);
    }
  }
  walk(root);
  return out.sort();
}

// ---- main -------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  const paths = args.length ? args : findAides(process.cwd());
  if (!paths.length) {
    console.error("no .aide files found");
    process.exit(1);
  }

  for (const p of paths) {
    const src = readFileSync(p, "utf8");
    const lock = buildLock(p, src);
    const out = writeLock(p, lock);
    console.log(`wrote ${relative(process.cwd(), out).replace(/\\/g, "/")}`);
    console.log(`  source sha : ${lock.source.sha256.slice(0, 16)}…`);
    console.log(`  content    : ${Object.entries(lock.summary).map(([k, n]) => `${n} ${k}`).join(", ")}`);
  }
}

main();
