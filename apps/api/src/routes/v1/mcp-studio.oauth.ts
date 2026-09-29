/**
 * MCP Studio operator OAuth routes (mcp-studio-spec, Authentication).
 *
 * A server whose auth mode is operator-oauth calls the upstream as the person
 * who ran the agent. When that person has no token, the call answers
 * "Connect your <label> account in Oxagen, then retry." with a link to the
 * connect route below.
 *
 * Mount points:
 *   GET  /v1/:org_slug/:workspace_slug/mcp-studio/oauth/connect?server=&environment=
 *        Signed-in session only. Sends the browser to the server's
 *        authorization server with PKCE and a one-time state, and sets a
 *        cookie that binds the callback to this browser.
 *   POST /v1/:org_slug/:workspace_slug/mcp-studio/oauth/disconnect
 *        Body { server, environment }. Revokes the caller's token at the
 *        authorization server and deletes it.
 *   GET  /oauth/mcp-studio/callback?code=&state=
 *        Public. The state names the operator and the workspace, and the
 *        cookie must carry the same state. Trades the code for tokens and
 *        stores them sealed.
 *
 * No response and no log line carries a token, a code, or a client secret.
 */
import { timingSafeEqual } from "node:crypto";
import { requireEnv } from "@oxagen/config/env";
import {
  beginConnect,
  ConnectError,
  defaultConnectDeps,
  disconnect,
  finishConnect,
} from "@oxagen/handlers/mcp-studio/credentials/connect";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv } from "../../app";

/** The cookie that binds a callback to the browser that started the connect. */
export const CONNECT_COOKIE = "oxagen_mcp_connect";
/** Where the public callback is mounted. The cookie's path. */
export const CALLBACK_BASE = "/oauth/mcp-studio";
const COOKIE_MAX_AGE_SECONDS = 600;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const targetSchema = z.object({
  server: z.string().min(1).max(64),
  environment: z.string().min(1).max(64),
});

/** The callback URI every OAuth client for MCP Studio registers. */
export function callbackUri(): string {
  const { NEXT_PUBLIC_API_URL } = requireEnv(["NEXT_PUBLIC_API_URL"] as const);
  return `${NEXT_PUBLIC_API_URL.replace(/\/+$/, "")}${CALLBACK_BASE}/callback`;
}

function sameState(cookie: string | undefined, state: string): boolean {
  if (cookie === undefined) return false;
  const a = Buffer.from(cookie);
  const b = Buffer.from(state);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const mcpStudioOauthRoute = new Hono<AppEnv>();

mcpStudioOauthRoute.get("/connect", async (c) => {
  const orgId = c.get("orgId");
  const workspaceId = c.get("workspaceId");
  const userId = c.get("userId");
  if (orgId === null || workspaceId === null || userId === null || !UUID.test(userId)) {
    return c.text("Sign in to Oxagen, then open the connect link again.", 401);
  }
  if (c.get("apiKeyId") !== null) {
    // The token belongs to a person, so a person's browser session connects it.
    return c.text("Open the connect link in a browser signed in to Oxagen. An API key cannot connect an account.", 403);
  }
  const target = targetSchema.safeParse({
    server: c.req.query("server"),
    environment: c.req.query("environment"),
  });
  if (!target.success) {
    return c.text("The connect link names no server or environment. Copy it again from the failed call.", 400);
  }
  let redirectUri: string;
  try {
    redirectUri = callbackUri();
  } catch {
    return c.text("The API has no public URL, so the authorization server has nowhere to send you back. Set NEXT_PUBLIC_API_URL on the API.", 503);
  }
  try {
    const started = await beginConnect(
      { orgId, workspaceId, userId, ...target.data, redirectUri },
      defaultConnectDeps(),
    );
    setCookie(c, CONNECT_COOKIE, started.state, {
      path: CALLBACK_BASE,
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

export const mcpStudioOauthCallbackRoute = new Hono<AppEnv>();

mcpStudioOauthCallbackRoute.get("/callback", async (c) => {
  const cookie = getCookie(c, CONNECT_COOKIE);
  deleteCookie(c, CONNECT_COOKIE, { path: CALLBACK_BASE });
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
    const connected = await finishConnect({ state, code }, defaultConnectDeps());
    return c.text(`${connected.label} is connected. Go back to Oxagen and retry the call.`, 200);
  } catch (error) {
    if (error instanceof ConnectError) return c.text(error.message, error.status);
    throw error;
  }
});
