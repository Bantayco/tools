// Publish a page version from the command line.
//
//   PUBLISH_KEY=... node scripts/publish.mjs <app> <file.html> [--promote] [--note "..."] [--url https://artifacts.bantay.co]
//
// Defaults: --url from BANTAY_URL or http://127.0.0.1:8787 (wrangler dev).
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const [, v] = args.splice(i, 2);
  return v;
};
const promote = args.includes("--promote") && args.splice(args.indexOf("--promote"), 1) && true;
const note = flag("--note") || "";
const url = flag("--url") || process.env.BANTAY_URL || "http://127.0.0.1:8787";
const [app, file] = args;
const key = process.env.PUBLISH_KEY;

if (!app || !file || !key) {
  console.error("usage: PUBLISH_KEY=... node scripts/publish.mjs <app> <file.html> [--promote] [--note text] [--url origin]");
  process.exit(2);
}

const res = await fetch(`${url}/api/apps/${app}/versions`, {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({ html: await readFile(file, "utf8"), note, promote }),
});
const body = await res.json();
if (!res.ok) {
  console.error(`publish failed (${res.status}): ${body.error}`);
  for (const e of body.errors || []) console.error("  - " + e);
  process.exit(1);
}
console.log(`${body.created ? "published" : "unchanged"} ${app}@${body.hash.slice(0, 12)}${body.promoted ? " (current)" : ""}`);
console.log(`${url}/${app}`);
