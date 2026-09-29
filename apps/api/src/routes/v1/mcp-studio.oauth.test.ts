/**
 * The MCP Studio operator OAuth routes: connect, disconnect, and the public
 * callback. The connect handlers are mocked, so these tests check what each
 * route accepts, what it refuses, and the cookie that binds a callback to the
 * browser that started the connect.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../app";

const mocks = vi.hoisted(() => ({
  beginConnect: vi.fn(),
  finishConnect: vi.fn(),
  disconnect: vi.fn(),
  defaultConnectDeps: vi.fn(),
  requireEnv: vi.fn(),
}));

vi.mock("@oxagen/handlers/mcp-studio/credentials/connect", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/handlers/mcp-studio/credentials/connect")>();
  return {
    ...real,
    beginConnect: mocks.beginConnect,
    finishConnect: mocks.finishConnect,
    disconnect: mocks.disconnect,
    defaultConnectDeps: mocks.defaultConnectDeps,
  };
});

vi.mock("@oxagen/config/env", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/config/env")>();
  return { ...real, requireEnv: mocks.requireEnv };
});

import { ConnectError } from "@oxagen/handlers/mcp-studio/credentials/connect";
import {
  CALLBACK_BASE,
  CONNECT_COOKIE,
  callbackUri,
  mcpStudioOauthCallbackRoute,
  mcpStudioOauthRoute,
} from "./mcp-studio.oauth";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";

const API_URL = "https://api.oxagen.test";
const REDIRECT_URI = `${API_URL}/oauth/mcp-studio/callback`;
const AUTH_URL = "https://auth.example.com/authorize?client_id=oxagen&state=state-abc-123";
const STATE = "state-abc-123";
const DEPS = { deps: "default" };

interface Caller {
  orgId: string | null;
  workspaceId: string | null;
  userId: string | null;
  apiKeyId: string | null;
}

const SIGNED_IN: Caller = {
  orgId: ORG_ID,
  workspaceId: WORKSPACE_ID,
  userId: USER_ID,
  apiKeyId: null,
};

/** The route behind middleware that sets the caller the auth middleware would. */
function mount(route: Hono<AppEnv>, caller: Partial<Caller> = {}): Hono<AppEnv> {
  const who: Caller = { ...SIGNED_IN, ...caller };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", "req_1");
    c.set("orgId", who.orgId);
    c.set("workspaceId", who.workspaceId);
    c.set("userId", who.userId);
    c.set("apiKeyId", who.apiKeyId);
    await next();
  });
  app.route("/", route);
  return app;
}

function connect(query: string, caller: Partial<Caller> = {}): Promise<Response> {
  return Promise.resolve(
    mount(mcpStudioOauthRoute, caller).fetch(new Request(`http://localhost/connect${query}`)),
  );
}

function disconnectRequest(body: string, caller: Partial<Caller> = {}): Promise<Response> {
  return Promise.resolve(
    mount(mcpStudioOauthRoute, caller).fetch(
      new Request("http://localhost/disconnect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    ),
  );
}

function callback(query: string, cookie: string | null): Promise<Response> {
  const headers = new Headers();
  if (cookie !== null) headers.set("cookie", `${CONNECT_COOKIE}=${cookie}`);
  return Promise.resolve(
    mount(mcpStudioOauthCallbackRoute).fetch(
      new Request(`http://localhost/callback${query}`, { headers }),
    ),
  );
}

function setCookie(res: Response): string {
  return res.headers.get("set-cookie") ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireEnv.mockReturnValue({ NEXT_PUBLIC_API_URL: API_URL });
  mocks.defaultConnectDeps.mockReturnValue(DEPS);
  mocks.beginConnect.mockResolvedValue({ authorizationUrl: AUTH_URL, state: STATE });
  mocks.finishConnect.mockResolvedValue({
    orgId: ORG_ID,
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    server: "billing",
    environment: "production",
    label: "Billing API",
  });
  mocks.disconnect.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── callbackUri ──────────────────────────────────────────────────────────────

describe("callbackUri", () => {
  it("appends the callback path to the API URL", () => {
    expect(callbackUri()).toBe(REDIRECT_URI);
  });

  it("strips trailing slashes from the API URL", () => {
    mocks.requireEnv.mockReturnValue({ NEXT_PUBLIC_API_URL: `${API_URL}//` });
    expect(callbackUri()).toBe(REDIRECT_URI);
  });

  it("asks requireEnv for the public API URL", () => {
    callbackUri();
    expect(mocks.requireEnv).toHaveBeenCalledWith(["NEXT_PUBLIC_API_URL"]);
  });
});

// ── GET /connect ─────────────────────────────────────────────────────────────

describe("GET /connect", () => {
  it("sends the browser to the authorization server and sets the state cookie", async () => {
    const res = await connect("?server=billing&environment=production");

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(AUTH_URL);
    const cookie = setCookie(res);
    expect(cookie).toContain(`${CONNECT_COOKIE}=${STATE}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain(`Path=${CALLBACK_BASE}`);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Max-Age=600");
  });

  it("starts the connect for the caller with the API's callback URI", async () => {
    await connect("?server=billing&environment=production");

    expect(mocks.beginConnect).toHaveBeenCalledWith(
      {
        orgId: ORG_ID,
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        server: "billing",
        environment: "production",
        redirectUri: REDIRECT_URI,
      },
      DEPS,
    );
  });

  it("sets no Secure flag when the API URL is plain http", async () => {
    mocks.requireEnv.mockReturnValue({ NEXT_PUBLIC_API_URL: "http://localhost:3001" });

    const res = await connect("?server=billing&environment=production");

    expect(res.status).toBe(302);
    expect(setCookie(res)).not.toContain("Secure");
    expect(mocks.beginConnect).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUri: "http://localhost:3001/oauth/mcp-studio/callback" }),
      DEPS,
    );
  });

  it.each<[string, Partial<Caller>]>([
    ["no user", { userId: null }],
    ["a user id that is not a UUID", { userId: "user_1" }],
    ["no organization", { orgId: null }],
    ["no workspace", { workspaceId: null }],
  ])("answers 401 for a caller with %s", async (_label, caller) => {
    const res = await connect("?server=billing&environment=production", caller);

    expect(res.status).toBe(401);
    expect(await res.text()).toBe("Sign in to Oxagen, then open the connect link again.");
    expect(mocks.beginConnect).not.toHaveBeenCalled();
  });

  it("answers 403 for an API key, because a person's browser connects the account", async () => {
    const res = await connect("?server=billing&environment=production", { apiKeyId: "key_1" });

    expect(res.status).toBe(403);
    expect(await res.text()).toContain("An API key cannot connect an account.");
    expect(mocks.beginConnect).not.toHaveBeenCalled();
  });

  it.each([
    ["no server", "?environment=production"],
    ["no environment", "?server=billing"],
    ["an empty server", "?server=&environment=production"],
    ["a server name longer than 64 characters", `?server=${"s".repeat(65)}&environment=production`],
  ])("answers 400 for a link with %s", async (_label, query) => {
    const res = await connect(query);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      "The connect link names no server or environment. Copy it again from the failed call.",
    );
    expect(mocks.beginConnect).not.toHaveBeenCalled();
  });

  it("answers 503 when the API has no public URL", async () => {
    mocks.requireEnv.mockImplementation(() => {
      throw new Error("NEXT_PUBLIC_API_URL is not set");
    });

    const res = await connect("?server=billing&environment=production");

    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Set NEXT_PUBLIC_API_URL on the API.");
    expect(mocks.beginConnect).not.toHaveBeenCalled();
  });

  it("answers a ConnectError with its own status and message", async () => {
    mocks.beginConnect.mockRejectedValue(
      new ConnectError(404, "not_published", "The workspace has published no server named billing."),
    );

    const res = await connect("?server=billing&environment=production");

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("The workspace has published no server named billing.");
    expect(setCookie(res)).toBe("");
  });

  it("rethrows any other error, which the app answers with 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.beginConnect.mockRejectedValue(new Error("the database is down"));

    const res = await connect("?server=billing&environment=production");

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("the database is down");
  });
});

// ── POST /disconnect ─────────────────────────────────────────────────────────

describe("POST /disconnect", () => {
  it("disconnects the caller's account and answers whether a token was held", async () => {
    const res = await disconnectRequest(JSON.stringify({ server: "billing", environment: "production" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ disconnected: true });
    expect(mocks.disconnect).toHaveBeenCalledWith(
      {
        orgId: ORG_ID,
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        server: "billing",
        environment: "production",
      },
      DEPS,
    );
  });

  it("answers disconnected false when the caller held no token", async () => {
    mocks.disconnect.mockResolvedValue(false);

    const res = await disconnectRequest(JSON.stringify({ server: "billing", environment: "production" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ disconnected: false });
  });

  it.each([
    ["no environment", JSON.stringify({ server: "billing" })],
    ["an empty server", JSON.stringify({ server: "", environment: "production" })],
    ["a body that is not an object", JSON.stringify(["billing", "production"])],
  ])("answers 400 for a body with %s", async (_label, body) => {
    const res = await disconnectRequest(body);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_request",
      message: "Send the server and the environment to disconnect.",
    });
    expect(mocks.disconnect).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not JSON", async () => {
    const res = await disconnectRequest("server=billing");

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
    expect(mocks.disconnect).not.toHaveBeenCalled();
  });

  it("answers 401 for a caller who is not signed in", async () => {
    const res = await disconnectRequest(JSON.stringify({ server: "billing", environment: "production" }), {
      userId: null,
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "unauthenticated",
      message: "Sign in to Oxagen, then disconnect again.",
    });
    expect(mocks.disconnect).not.toHaveBeenCalled();
  });
});

// ── GET /callback ────────────────────────────────────────────────────────────

describe("GET /callback", () => {
  it("trades the code and says which server is connected", async () => {
    const res = await callback(`?code=code-1&state=${STATE}`, STATE);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Billing API is connected. Go back to Oxagen and retry the call.");
    expect(mocks.finishConnect).toHaveBeenCalledWith({ state: STATE, code: "code-1" }, DEPS);
  });

  it("clears the state cookie on the callback path", async () => {
    const res = await callback(`?code=code-1&state=${STATE}`, STATE);

    const cookie = setCookie(res);
    expect(cookie).toContain(`${CONNECT_COOKIE}=;`);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain(`Path=${CALLBACK_BASE}`);
  });

  it("answers 400 with the provider's error code and connects nothing", async () => {
    const res = await callback(`?error=access_denied&state=${STATE}`, STATE);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      "The authorization server answered access_denied, so nothing was connected. Start again from Oxagen.",
    );
    expect(setCookie(res)).toContain("Max-Age=0");
    expect(mocks.finishConnect).not.toHaveBeenCalled();
  });

  it("replaces a provider error outside the OAuth alphabet with plain words", async () => {
    const error = encodeURIComponent("<script>alert(1)</script>");

    const res = await callback(`?error=${error}&state=${STATE}`, STATE);

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("answered an error, so nothing was connected.");
    expect(text).not.toContain("<script>");
    expect(mocks.finishConnect).not.toHaveBeenCalled();
  });

  it.each([
    ["no code", `?state=${STATE}`],
    ["no state", "?code=code-1"],
    ["an empty code", `?code=&state=${STATE}`],
    ["an empty state", "?code=code-1&state="],
  ])("answers 400 for a callback with %s", async (_label, query) => {
    const res = await callback(query, STATE);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("The authorization server sent no code. Start again from Oxagen.");
    expect(mocks.finishConnect).not.toHaveBeenCalled();
  });

  it.each<[string, string | null]>([
    ["no cookie", null],
    ["a cookie of a different length", "short"],
    ["a cookie of the same length", "state-abc-124"],
  ])("answers 400 for a callback with %s and connects nothing", async (_label, cookie) => {
    const res = await callback(`?code=code-1&state=${STATE}`, cookie);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      "This connect link was started in another browser, or it expired. Start again from Oxagen.",
    );
    expect(mocks.finishConnect).not.toHaveBeenCalled();
  });

  it("answers a ConnectError with its own status and message", async () => {
    mocks.finishConnect.mockRejectedValue(
      new ConnectError(400, "expired_state", "The connect link expired. Start again from Oxagen."),
    );

    const res = await callback(`?code=code-1&state=${STATE}`, STATE);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("The connect link expired. Start again from Oxagen.");
  });

  it("rethrows any other error, which the app answers with 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.finishConnect.mockRejectedValue(new Error("the token endpoint sent code-1 back"));

    const res = await callback(`?code=code-1&state=${STATE}`, STATE);

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("code-1");
  });
});
