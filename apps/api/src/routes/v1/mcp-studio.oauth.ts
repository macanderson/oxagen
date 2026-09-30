/**
 * MCP Studio operator OAuth routes (mcp-studio-spec, Authentication).
 *
 * A server whose auth mode is operator-oauth calls the upstream as the person
 * who ran the agent. When that person has no token, the call answers
 * "Connect your <label> account in Oxagen, then retry." with a link to the
 * connect route below.
 *
 * The browser reaches the connect route and the callback on the app's origin,
 * at /api/v1/..., which the app proxies here. Better Auth's session cookie
 * belongs to the app host alone, so a browser sends it only there. The state
 * cookie the connect sets lands on the app host too, and the callback on the
 * same host gets it back.
 *
 * Mount points:
 *   GET  /v1/:org_slug/:workspace_slug/mcp-studio/oauth/connect?server=&environment=
 *        Signed-in session only. Sends the browser to the server's
 *        authorization server with PKCE and a one-time state, and sets a
 *        cookie that binds the callback to this browser.
 *   GET  /v1/:org_slug/:workspace_slug/mcp-studio/oauth/callback?code=&state=
 *        Signed-in session only. The cookie must carry the state, and the
 *        state must name the caller. Trades the code for tokens and stores
 *        them sealed.
 *   POST /v1/:org_slug/:workspace_slug/mcp-studio/oauth/disconnect
 *        Body { server, environment }. Revokes the caller's token at the
 *        authorization server and deletes it.
 *   GET  /oauth/mcp-studio/callback
 *        Retired. The API-host callback never received the state cookie, so
 *        it answers 410 and asks the operator to start again.
 *
 * No response and no log line carries a token, a code, or a client secret.
 */
import { timingSafeEqual } from "node:crypto";
import {
  beginConnect,
  ConnectError,
  defaultConnectDeps,
  disconnect,
  finishConnect,
  mcpStudioAppOrigin,
  mcpStudioOauthPath,
  mcpStudioOauthUrl,
} from "@oxagen/handlers/mcp-studio/credentials/connect";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv } from "../../app";

/** The cookie that binds a callback to the browser that started the connect. */
export const CONNECT_COOKIE = "oxagen_mcp_connect";
/** Where the retired public callback is mounted. */
export const CALLBACK_BASE = "/oauth/mcp-studio";
const COOKIE_MAX_AGE_SECONDS = 600;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const targetSchema = z.object({
  server: z.string().min(1).max(64),
  environment: z.string().min(1).max(64),
});

interface Slugs {
  orgSlug: string;
  workspaceSlug: string;
}

/**
 * The redirect URI for a workspace's connects: its callback on the app's
 * origin. The connect saves it with the state, so the token request sends the
 * same URI the authorization request did.
 */
export function callbackUri(slugs: Slugs, appBaseUrl: string = mcpStudioAppOrigin()): string {
  return mcpStudioOauthUrl({ appBaseUrl, ...slugs }, "callback");
}

/** The state cookie's path: the callback's path as the browser sees it. */
export function connectCookiePath(slugs: Slugs): string {
  return `${mcpStudioOauthPath(slugs)}/callback`;
}

function slugsOf(c: Context<AppEnv>): Slugs | null {
  const orgSlug = c.req.param("org_slug");
  const workspaceSlug = c.req.param("workspace_slug");
  if (!orgSlug || !workspaceSlug) return null;
  return { orgSlug, workspaceSlug };
}

function sameState(cookie: string | undefined, state: string): boolean {
  if (cookie === undefined) return false;
  const a = Buffer.from(cookie);
  const b = Buffer.from(state);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The signed-in person behind a browser session, or null. */
function sessionCaller(c: Context<AppEnv>): { orgId: string; workspaceId: string; userId: string } | null {
  const orgId = c.get("orgId");
  const workspaceId = c.get("workspaceId");
  const userId = c.get("userId");
  if (orgId === null || workspaceId === null || userId === null || !UUID.test(userId)) return null;
  return { orgId, workspaceId, userId };
}

export const mcpStudioOauthRoute = new Hono<AppEnv>();

mcpStudioOauthRoute.get("/connect", async (c) => {
  const caller = sessionCaller(c);
  if (caller === null) {
    return c.text("Sign in to Oxagen, then open the connect link again.", 401);
  }
  if (c.get("apiKeyId") !== null) {
    // The token belongs to a person, so a person's browser session connects it.
    return c.text("Open the connect link in a browser signed in to Oxagen. An API key cannot connect an account.", 403);
  }
  const slugs = slugsOf(c);
  if (slugs === null) return c.notFound();
  const target = targetSchema.safeParse({
    server: c.req.query("server"),
    environment: c.req.query("environment"),
  });
  if (!target.success) {
    return c.text("The connect link names no server or environment. Copy it again from the failed call.", 400);
  }
  const redirectUri = callbackUri(slugs);
  try {
    const started = await beginConnect({ ...caller, ...target.data, redirectUri }, defaultConnectDeps());
    setCookie(c, CONNECT_COOKIE, started.state, {
      path: connectCookiePath(slugs),
      httpOnly: true,
      sameSite: "Lax",
      secure: redirectUri.startsWith("https://"),
      maxAge: COOKIE_MAX_AGE_SECONDS,
    });
    return c.redirect(started.authorizationUrl, 302);
  } catch (error) {
    if (error instanceof ConnectError) return c.text(error.message, error.status);
    throw error;
  }
});

mcpStudioOauthRoute.get("/callback", async (c) => {
  const slugs = slugsOf(c);
  if (slugs === null) return c.notFound();
  const cookie = getCookie(c, CONNECT_COOKIE);
  deleteCookie(c, CONNECT_COOKIE, { path: connectCookiePath(slugs) });
  const caller = sessionCaller(c);
  if (caller === null || c.get("apiKeyId") !== null) {
    return c.text("Sign in to Oxagen in this browser, then start the connect again.", 401);
  }
  const providerError = c.req.query("error");
  if (providerError !== undefined) {
    // The authorization server's error code, cut to its RFC 6749 alphabet so
    // nothing it sent lands in the page as markup.
    const code = /^[a-z_]{1,64}$/.test(providerError) ? providerError : "an error";
    return c.text(`The authorization server answered ${code}, so nothing was connected. Start again from Oxagen.`, 400);
  }
  const state = c.req.query("state");
  const code = c.req.query("code");
  if (state === undefined || code === undefined || state === "" || code === "") {
    return c.text("The authorization server sent no code. Start again from Oxagen.", 400);
  }
  if (!sameState(cookie, state)) {
    return c.text("This connect link was started in another browser, or it expired. Start again from Oxagen.", 400);
  }
  try {
    const connected = await finishConnect({ state, code, caller }, defaultConnectDeps());
    return c.text(`${connected.label} is connected. Go back to Oxagen and retry the call.`, 200);
  } catch (error) {
    if (error instanceof ConnectError) return c.text(error.message, error.status);
    throw error;
  }
});

mcpStudioOauthRoute.post("/disconnect", async (c) => {
  const orgId = c.get("orgId");
  const workspaceId = c.get("workspaceId");
  const userId = c.get("userId");
  if (orgId === null || workspaceId === null || userId === null || !UUID.test(userId)) {
    return c.json({ error: "unauthenticated", message: "Sign in to Oxagen, then disconnect again." }, 401);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = null;
  }
  const target = targetSchema.safeParse(body);
  if (!target.success) {
    return c.json({ error: "invalid_request", message: "Send the server and the environment to disconnect." }, 400);
  }
  const disconnected = await disconnect({ orgId, workspaceId, userId, ...target.data }, defaultConnectDeps());
  return c.json({ disconnected });
});

/**
 * The retired API-host callback. Connects started before the move to the app
 * origin named it as their redirect URI, and it never received their state
 * cookie. It clears any such cookie and sends the operator back to start again.
 */
export const mcpStudioOauthCallbackRoute = new Hono<AppEnv>();

mcpStudioOauthCallbackRoute.get("/callback", (c) => {
  deleteCookie(c, CONNECT_COOKIE, { path: CALLBACK_BASE });
  return c.text("This connect link is out of date, so nothing was connected. Start again from Oxagen.", 410);
});
