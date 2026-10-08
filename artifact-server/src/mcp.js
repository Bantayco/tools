// MCP interface (Streamable HTTP transport, stateless, JSON responses).
//
// Lets any LLM client publish page code and edit page data:
//   - page tools need `Authorization: Bearer <PUBLISH_KEY>` on the request
//   - session tools take an agent token (minted by the page owner in the page
//     menu). Only pages declared `"encryption": "none"` can mint one: end-to-end
//     encrypted pages keep their key in browsers, so no server-side agent can
//     read or write them. That is the deliberate answer to "MCP vs E2E".

import { HttpError, APP_NAME, HASH, RESERVED_APPS, UUID_V4, hasKey, json, unwrap } from "./util.js";
import { registry, session } from "./stubs.js";

const PROTOCOL = "2025-06-18";

const str = (description) => ({ type: "string", description });

const TOOLS = [
  {
    name: "list_apps",
    description: "List published apps (page code) with their current version. Requires the publish key.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_versions",
    description: "List an app's immutable versions, newest first, with declared schemas. Requires the publish key.",
    inputSchema: { type: "object", properties: { app: str("App name") }, required: ["app"] },
  },
  {
    name: "get_version",
    description: "Fetch an app version's HTML (current version if hash omitted). Requires the publish key.",
    inputSchema: { type: "object", properties: { app: str("App name"), hash: str("Version hash (optional)") }, required: ["app"] },
  },
  {
    name: "publish_version",
    description:
      "Publish new page HTML for an app. Stored immutably by content hash. The schema declared in " +
      '<script type="application/json" id="bantay-schema"> must be add-only versus every earlier version ' +
      "(no removed/retyped fields, every field has a default). Set promote=true to make it current. Requires the publish key.",
    inputSchema: {
      type: "object",
      properties: { app: str("App name"), html: str("Full HTML document"), note: str("Change note"), promote: { type: "boolean" } },
      required: ["app", "html"],
    },
  },
  {
    name: "promote_version",
    description: "Point an app at a version (promote or roll back). Open pages are notified. Requires the publish key.",
    inputSchema: { type: "object", properties: { app: str("App name"), version: str("Version hash") }, required: ["app", "version"] },
  },
  {
    name: "read_session",
    description: "Read a page session's data: state (with version), numbered log, and doc updates. Needs an agent token.",
    inputSchema: { type: "object", properties: { session_id: str("Page UUID"), token: str("Agent token") }, required: ["session_id", "token"] },
  },
  {
    name: "save_state",
    description:
      "Replace the session state document. base_version must equal the current state version (from read_session); " +
      "otherwise the save is rejected and the latest state is returned so you can merge and retry. Preserve unknown fields.",
    inputSchema: {
      type: "object",
      properties: { session_id: str("Page UUID"), token: str("Agent token"), base_version: { type: "integer" }, data: { type: "object" } },
      required: ["session_id", "token", "base_version", "data"],
    },
  },
  {
    name: "append_log",
    description:
      "Append an entry {type, data} to the session's numbered log. Pass n to claim a specific number " +
      "(first write of N wins); omit to take the next free number.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: str("Page UUID"),
        token: str("Agent token"),
        entry: { type: "object", properties: { type: { type: "string" }, data: {} }, required: ["type"] },
        n: { type: "integer" },
      },
      required: ["session_id", "token", "entry"],
    },
  },
];

async function callTool(name, args, request, env) {
  const needPublish = async () => {
    if (!(await hasKey(request, env.PUBLISH_KEY))) throw new HttpError(401, "publish key required (Authorization: Bearer)");
  };
  const app = () => {
    if (!APP_NAME.test(args.app || "") || RESERVED_APPS.has(args.app)) throw new HttpError(400, "bad app name");
    return args.app;
  };
  const sess = () => {
    if (!UUID_V4.test(args.session_id || "")) throw new HttpError(400, "bad session_id");
    return session(env, args.session_id);
  };
  const reg = registry(env);

  switch (name) {
    case "list_apps":
      await needPublish();
      return reg.listApps();
    case "list_versions":
      await needPublish();
      return reg.listVersions(app());
    case "get_version": {
      await needPublish();
      if (args.hash && !HASH.test(args.hash)) throw new HttpError(400, "bad hash");
      const v = await reg.getVersion(app(), args.hash || null);
      if (!v) throw new HttpError(404, "unknown app or version");
      return v;
    }
    case "publish_version":
      await needPublish();
      return unwrap(await reg.publish(app(), args.html, { note: args.note, promote: !!args.promote }));
    case "promote_version":
      await needPublish();
      if (!HASH.test(args.version || "")) throw new HttpError(400, "bad version");
      return unwrap(await reg.promote(app(), args.version));
    case "read_session":
      return unwrap(await sess().mcpRead(args.token));
    case "save_state":
      return unwrap(await sess().mcpSave(args.token, args.base_version, args.data));
    case "append_log":
      return unwrap(await sess().mcpAppend(args.token, args.n ?? null, args.entry));
  }
  throw new HttpError(404, `unknown tool ${name}`);
}

async function handleMessage(msg, request, env) {
  const { id, method, params = {} } = msg || {};
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  if (!msg || msg.jsonrpc !== "2.0" || typeof method !== "string") return err(-32600, "invalid request");
  if (id === undefined) return null; // notification

  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "bantay-artifacts", version: "1.0.0" },
        instructions:
          "Bantay Artifact Server. Apps are published HTML pages; sessions are UUID-addressed data for one app. " +
          "Publishing needs the publish key as a Bearer token. Session data needs an agent token minted by the page owner.",
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call":
      try {
        const result = await callTool(params.name, params.arguments || {}, request, env);
        return ok({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: { result } });
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        const detail = e.extra ? " " + JSON.stringify(e.extra) : "";
        return ok({ content: [{ type: "text", text: `Error ${e.status}: ${e.message}${detail}` }], isError: true });
      }
  }
  return err(-32601, `method not found: ${method}`);
}

export async function handleMcp(request, env) {
  if (request.method !== "POST") return json({ error: "use POST (Streamable HTTP, JSON responses)" }, 405, { allow: "POST" });
  // Browsers can't reach this cross-origin with credentials; reject any foreign Origin outright.
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, "cross-origin request refused");
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
  }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleMessage(m, request, env)))).filter(Boolean);
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const out = await handleMessage(body, request, env);
  return out ? json(out) : new Response(null, { status: 202 });
}
