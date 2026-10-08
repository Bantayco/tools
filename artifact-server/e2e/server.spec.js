// End-to-end: real Worker + Durable Objects via wrangler dev.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const PUB = { authorization: "Bearer test-publish" };
const ADMIN = { authorization: "Bearer test-admin" };
const VIEW_PASS = "view-pass-123";
const OWNER_PASS = "owner-pass-456";

const notesPage = (extra = "") => `<!doctype html><html><head><title>Notes</title>
<script type="application/json" id="bantay-schema">{"encryption":"none","state":{"text":{"type":"string","default":"empty"}${extra}}}</script>
</head><body><p id="out"></p><script type="module">
import { bantay } from "/_bantay/client.js";
const show = () => (document.getElementById("out").textContent = bantay.state.text);
bantay.on("state", show); await bantay.ready; show();
window.setText = (t) => bantay.save((s) => ({ ...s, text: t }));
</script></body></html>`;

async function publish(request, app, html, promote = true) {
  const res = await request.post(`/api/apps/${app}/versions`, { headers: PUB, data: { html, promote } });
  return { status: res.status(), body: await res.json() };
}

const bar = (page) => page.locator("bantay-ui [data-testid=bantay-role]");

async function firstSave(page) {
  await page.locator("bantay-ui .bar button", { hasText: "Save" }).click();
  await page.getByTestId("bantay-view-pass").fill(VIEW_PASS);
  await page.getByTestId("bantay-owner-pass").fill(OWNER_PASS);
  await page.locator("bantay-ui .dialog button[type=submit]").click();
  await expect(bar(page)).toHaveText("Owner", { timeout: 20_000 });
  await expect(page).toHaveURL(/\?id=[0-9a-f-]{36}$/);
  return new URL(page.url()).searchParams.get("id");
}

async function unlock(page, pass) {
  await page.getByTestId("bantay-passcode").fill(pass);
  await page.locator("bantay-ui .dialog button[type=submit]").click();
}

test.beforeAll(async ({ request }) => {
  const html = await readFile(new URL("../apps/picks/index.html", import.meta.url), "utf8");
  expect((await publish(request, "picks", html)).status).toBe(201);
});

test("publishing needs the publish key and enforces add-only schemas", async ({ request }) => {
  const denied = await request.post("/api/apps/notes/versions", { headers: ADMIN, data: { html: notesPage() } });
  expect(denied.status()).toBe(401);

  const v1 = await publish(request, "schematest", notesPage());
  expect(v1.status).toBe(201);
  const breaking = await publish(request, "schematest", notesPage().replace('"type":"string","default":"empty"', '"type":"number","default":0'));
  expect(breaking.status).toBe(422);
  expect(breaking.body.errors.join()).toContain("retyped string -> number");
  const noDefault = await publish(request, "schematest", notesPage(',"n":{"type":"number"}'));
  expect(noDefault.status).toBe(422);
  const additive = await publish(request, "schematest", notesPage(',"n":{"type":"number","default":0}'), false);
  expect(additive.status).toBe(201);

  // Versions are immutable and the pointer moves both ways (promote / roll back).
  const list = await (await request.get("/api/apps/schematest/versions", { headers: PUB })).json();
  expect(list).toHaveLength(2);
  expect(list.find((v) => v.current).hash).toBe(v1.body.hash);
  const promoted = await request.post("/api/apps/schematest/promote", { headers: PUB, data: { version: additive.body.hash } });
  expect((await promoted.json()).current).toBe(additive.body.hash);
});

test("pages carry no state and strict headers", async ({ request }) => {
  const res = await request.get("/picks");
  expect(res.headers()["referrer-policy"]).toBe("no-referrer");
  expect(res.headers()["x-robots-tag"]).toContain("noindex");
  expect(res.headers()["content-security-policy"]).toContain("default-src 'self'");
  expect(await res.text()).toContain('id="bantay-page"');
  expect((await request.get("/nope")).status()).toBe(404);
  const meta = await request.get("/api/s/00000000-0000-4000-8000-000000000000/meta");
  expect(meta.status()).toBe(404);
});

test("picks pool: blank → save → locked → viewer live → pairing → log conflicts", async ({ page, browser, baseURL }) => {
  // Blank: no UUID, edits stay local.
  await page.goto("/picks");
  await expect(bar(page)).toHaveText("Draft");
  await page.fill("#playerIn", "Ana");
  await page.click("#playerForm button");
  await page.fill("#playerIn", "Ben");
  await page.click("#playerForm button");
  await page.fill("#weekIn", "Week 1");
  await page.click("#weekForm button");
  await page.fill("#awayIn", "KC");
  await page.fill("#homeIn", "BUF");
  await page.fill("#kickIn", "2099-01-01T13:00");
  await page.click("#gameForm button");
  await expect(bar(page)).toHaveText("Not saved");
  await page.selectOption("#me", "Ana");
  await page.locator("#board button.team", { hasText: "KC" }).click();
  await expect(page.locator("#board button.team.mine")).toHaveText("KC");

  // First save mints the UUID + owner token and uploads local work.
  const id = await firstSave(page);
  await expect(page.locator("#board th", { hasText: "Ben" })).toBeVisible();

  // Server holds ciphertext only.
  const raw = await page.evaluate(
    (id) => new Promise((resolve) => {
      const ws = new WebSocket(`ws://${location.host}/api/s/${id}/ws`);
      ws.onmessage = (e) => { resolve(e.data); ws.close(); };
    }),
    id,
  );
  const hello = JSON.parse(raw);
  expect(hello.role).toBe("owner");
  expect(typeof hello.state.data).toBe("string");
  expect(raw).not.toContain('"Ana"');
  expect(raw).not.toContain('"KC"');
  expect(hello.log).toHaveLength(1);

  // A new device is Locked; wrong passcode is refused; view passcode -> Viewer.
  const viewerCtx = await browser.newContext();
  const viewer = await viewerCtx.newPage();
  await viewer.goto(`/picks?id=${id}`);
  await expect(bar(viewer)).toHaveText("Locked");
  await expect(viewer.locator("#board th", { hasText: "Ana" })).toHaveCount(0);
  await unlock(viewer, "not-the-passcode");
  await expect(viewer.locator("bantay-ui .err")).toContainText("Wrong passcode", { timeout: 20_000 });
  await unlock(viewer, VIEW_PASS);
  await expect(bar(viewer)).toHaveText("View only", { timeout: 20_000 });
  await expect(viewer.locator("#board th", { hasText: "Ana" })).toBeVisible();
  await expect(viewer.locator("#admin")).toBeHidden();
  expect(await viewer.evaluate(() => window.bantay.save({}).catch((e) => e.message))).toContain("read-only");

  // Live updates stream to every open device.
  await page.fill("#playerIn", "Cy");
  await page.click("#playerForm button");
  await expect(viewer.locator("#board th", { hasText: "Cy" })).toBeVisible();
  await page.fill("#chatText", "see you sunday");
  await page.click("#chatForm button");
  await expect(viewer.locator("#msgs")).toContainText("see you sunday");

  // A valid token cookie + stored key skips Locked on reload.
  await viewer.reload();
  await expect(bar(viewer)).toHaveText("View only");
  await expect(viewer.locator("#board th", { hasText: "Cy" })).toBeVisible();
  await expect(viewer.locator("#msgs")).toContainText("see you sunday");

  // Viewer -> Owner with the owner passcode.
  await viewer.locator("bantay-ui .bar button", { hasText: "Unlock to edit" }).click();
  await unlock(viewer, OWNER_PASS);
  await expect(bar(viewer)).toHaveText("Owner", { timeout: 20_000 });

  // QR pairing: single-use, redeemed by a tap, carries the data key in the #fragment.
  await page.locator("bantay-ui .bar button", { hasText: "⋯" }).click();
  await page.locator("bantay-ui .menu button", { hasText: "Pair a device (owner)" }).click();
  const pairUrl = await page.getByTestId("bantay-pair-url").textContent();
  expect(pairUrl).toContain(`?id=${id}#pair=`);
  await page.locator("bantay-ui .dialog button", { hasText: "Done" }).click();
  const pairedCtx = await browser.newContext();
  const paired = await pairedCtx.newPage();
  await paired.goto(pairUrl.replace(/^https?:\/\/[^/]+/, baseURL));
  await expect(bar(paired)).toHaveText("Locked");
  await paired.getByTestId("bantay-redeem").click();
  await expect(bar(paired)).toHaveText("Owner", { timeout: 20_000 });
  await expect(paired.locator("#board th", { hasText: "Cy" })).toBeVisible();
  expect(paired.url()).not.toContain("#pair");

  const againCtx = await browser.newContext();
  const again = await againCtx.newPage();
  await again.goto(pairUrl.replace(/^https?:\/\/[^/]+/, baseURL));
  await again.getByTestId("bantay-redeem").click();
  await expect(again.locator("bantay-ui .dialog")).toContainText("already used");

  // Numbered log: first write of N wins, the other is rejected.
  const n = await page.evaluate(() => window.bantay.log.at(-1).n + 1);
  await expect.poll(() => paired.evaluate(() => window.bantay.log.length)).toBe(n - 1);
  expect(await page.evaluate((n) => window.bantay.append("pick", { player: "Ben", game: "x", team: "BUF", at: 1 }, { n }), n)).toBe(n);
  const loser = await paired.evaluate((n) => window.bantay.append("pick", { player: "Cy", game: "x", team: "KC", at: 1 }, { n }).catch((e) => ({ name: e.name, head: e.head })), n);
  expect(loser).toEqual({ name: "ConflictError", head: n });
  await expect.poll(() => viewer.evaluate(() => window.bantay.log.at(-1).data.player)).toBe("Ben");

  // Concurrent state saves: updaters re-run against the winner, nothing lost.
  await Promise.all([
    page.evaluate(() => window.bantay.save((s) => ({ ...s, players: [...s.players, "Dee"] }))),
    paired.evaluate(() => window.bantay.save((s) => ({ ...s, players: [...s.players, "Eve"] }))),
  ]);
  await expect.poll(() => viewer.evaluate(() => [...window.bantay.state.players].sort().join())).toBe("Ana,Ben,Cy,Dee,Eve");

  // Owner signs out other devices: the viewer-turned-owner drops to Locked.
  await page.locator("bantay-ui .bar button", { hasText: "⋯" }).click();
  await page.locator("bantay-ui .menu button", { hasText: "Sign out other devices" }).click();
  await page.locator("bantay-ui .dialog button", { hasText: "Confirm" }).click();
  await expect(bar(viewer)).toHaveText("Locked", { timeout: 20_000 });
  await expect(bar(page)).toHaveText("Owner");

  for (const c of [viewerCtx, pairedCtx, againCtx]) await c.close();
});

test("passcode attempts are rate-limited", async ({ request, page }) => {
  await publish(request, "ratetest", notesPage());
  await page.goto("/ratetest");
  const id = await page.evaluate(() => window.bantay.ready.then(() => window.bantay.create("aaaaaa1", "bbbbbb2")));
  const headers = { origin: new URL(page.url()).origin };
  const bad = { verifiers: { view: "x".repeat(43), owner: "y".repeat(43) } };
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await request.post(`/api/s/${id}/unlock`, { headers, data: bad })).status());
  expect(codes).toEqual([403, 403, 403, 403, 403, 429]);
  // Cross-origin POSTs never reach the session.
  expect((await request.post(`/api/s/${id}/unlock`, { headers: { origin: "https://evil.example" }, data: bad })).status()).toBe(403);
});

test("MCP edits plaintext pages live; new versions reach open pages", async ({ request, page }) => {
  await publish(request, "notes", notesPage());
  await page.goto("/notes");
  await page.evaluate(() => window.setText("hello"));
  const id = await firstSave(page);
  await expect(page.locator("#out")).toHaveText("hello");

  await page.locator("bantay-ui .bar button", { hasText: "⋯" }).click();
  await page.locator("bantay-ui .menu button", { hasText: "Connect an LLM" }).click();
  const token = await page.getByTestId("bantay-agent-token").textContent();

  const mcp = async (name, args, headers = {}) => {
    const res = await request.post("/mcp", { headers, data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
    return (await res.json()).result;
  };
  const init = await request.post("/mcp", { data: { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } } });
  expect((await init.json()).result.serverInfo.name).toBe("bantay-artifacts");

  const read = await mcp("read_session", { session_id: id, token });
  expect(read.structuredContent.result.state.data.text).toBe("hello");
  const v = read.structuredContent.result.state.v;
  const saved = await mcp("save_state", { session_id: id, token, base_version: v, data: { text: "from the llm" } });
  expect(saved.structuredContent.result.ok).toBe(true);
  await expect(page.locator("#out")).toHaveText("from the llm");
  const stale = await mcp("save_state", { session_id: id, token, base_version: v, data: { text: "stale" } });
  expect(stale.structuredContent.result.ok).toBe(false);
  expect((await mcp("read_session", { session_id: id, token: "wrong" })).isError).toBe(true);
  expect((await mcp("list_apps", {})).isError).toBe(true);
  expect((await mcp("list_apps", {}, PUB)).isError).toBeFalsy();

  // Publish + promote over MCP: the open page is told and reloads onto it.
  const before = await page.evaluate(() => window.bantay.version);
  const pub = await mcp("publish_version", { app: "notes", html: notesPage(',"tags":{"type":"array","default":[]}'), promote: true }, PUB);
  expect(pub.isError).toBeFalsy();
  await expect.poll(() => page.evaluate(() => window.bantay?.version).catch(() => before), { timeout: 20_000 }).not.toBe(before);
  await expect(page.locator("#out")).toHaveText("from the llm");
  expect(await page.evaluate(() => window.bantay.state.tags)).toEqual([]); // new field -> default

  // Cookie-authenticated calls from another origin are refused.
  const res = await request.post(`/api/s/${id}/agent-token`, { headers: { origin: "https://evil.example" } });
  expect(res.status()).toBe(403);
});

test("admin: list sessions and mint a recovery owner link", async ({ request, page, browser, baseURL }) => {
  await publish(request, "notes", notesPage());
  await page.goto("/notes");
  const id = await page.evaluate(() => window.bantay.ready.then(() => window.bantay.create("aaaaaa1", "bbbbbb2")));

  expect((await request.get("/api/admin/sessions", { headers: PUB })).status()).toBe(401);
  const sessions = await (await request.get("/api/admin/sessions?app=notes", { headers: ADMIN })).json();
  expect(sessions.map((s) => s.id)).toContain(id);
  const info = await (await request.get(`/api/admin/s/${id}`, { headers: ADMIN })).json();
  expect(info.tokens).toHaveLength(1);

  const claim = await (await request.post(`/api/admin/s/${id}/claim`, { headers: ADMIN })).json();
  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  await other.goto(claim.url.replace(/^https?:\/\/[^/]+/, baseURL));
  await other.getByTestId("bantay-redeem").click();
  await expect(bar(other)).toHaveText("Owner", { timeout: 20_000 });
  await ctx.close();

  // Admin page loads.
  await page.goto("/admin");
  await page.fill("#adminKey", "test-admin");
  await page.dispatchEvent("#adminKey", "change");
  await page.click("#load");
  await expect(page.locator("#apps")).toContainText("notes");
  await expect(page.locator("#sessions")).toContainText(id);
});
