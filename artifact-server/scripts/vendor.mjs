// Bundles the browser libraries the client needs into public/_bantay/vendor/,
// so pages load nothing from third-party CDNs (CSP stays 'self'-only).
// Run after bumping yjs or qrcode-generator:  npm run vendor
import { build } from "esbuild";

const out = new URL("../public/_bantay/vendor/", import.meta.url).pathname;
const common = { bundle: true, format: "esm", minify: true, platform: "browser", target: "es2020", logLevel: "info" };

await build({ ...common, stdin: { contents: 'export * from "yjs";', resolveDir: process.cwd() }, outfile: out + "yjs.js" });
await build({ ...common, stdin: { contents: 'import q from "qrcode-generator"; export default q;', resolveDir: process.cwd() }, outfile: out + "qr.js" });
