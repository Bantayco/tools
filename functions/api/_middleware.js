// Runs before every /api/* Function. Establishes the caller's identity from
// the Cloudflare Access JWT and exposes it as context.data.userId / .email.
import { json, verifyAccessJwt, getCookie } from "./_lib.js";

export async function onRequest(context) {
  const { request, env, next, data } = context;

  // Local dev escape hatch: `wrangler pages dev` has no Access in front, so
  // set DEV_USER to act as a fixed identity. NEVER set this in production.
  if (env.DEV_USER) {
    data.userId = env.DEV_USER;
    data.email = env.DEV_USER;
    return next();
  }

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return json({ error: "Auth not configured" }, 500);
  }

  const token =
    request.headers.get("Cf-Access-Jwt-Assertion") ||
    getCookie(request, "CF_Authorization");
  if (!token) return json({ error: "Unauthorized" }, 401);

  try {
    const payload = await verifyAccessJwt(
      token,
      env.ACCESS_TEAM_DOMAIN,
      env.ACCESS_AUD
    );
    data.userId = payload.sub;
    data.email = payload.email;
  } catch (err) {
    return json({ error: "Unauthorized", detail: err.message }, 401);
  }

  return next();
}
