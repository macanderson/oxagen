// The bearer path of the real auth middleware: an API key binds the org and
// workspace and the user the resolver returns, which is null for every key but
// one minted by the CLI authorize flow. A handler that gates on the caller's
// role resolves the key's creator (`resolveActingUserId`) and passes that user
// to `assertOrgRole`; `merge_context_pr` needs a signed-in reviewer and
// refuses a null user with `no_principal`.
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app";

const mocks = vi.hoisted(() => ({
  resolveApiKey: vi.fn(),
  resolveSession: vi.fn(),
}));
vi.mock("@oxagen/auth", () => ({
  parseSessionCookie: (cookie: string | undefined) =>
    cookie?.match(/session=([^;]+)/)?.[1] ?? null,
  resolveApiKey: mocks.resolveApiKey,
  resolveSession: mocks.resolveSession,
}));

vi.mock("./logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { authMiddleware } from "./auth";
import { errorMiddleware } from "./error";

function appWithAuth() {
  const app = new Hono<AppEnv>();
  app.use("*", authMiddleware);
  app.get("/whoami", (c) =>
    c.json({
      userId: c.get("userId"),
      apiKeyId: c.get("apiKeyId"),
      orgId: c.get("orgId"),
      workspaceId: c.get("workspaceId"),
    }),
  );
  return app;
}

beforeEach(() => {
  mocks.resolveApiKey.mockReset();
  mocks.resolveSession.mockReset();
});

describe("authMiddleware", () => {
  it("binds an API key's org and workspace and no user", async () => {
    mocks.resolveApiKey.mockResolvedValueOnce({
      ok: true,
      userId: null,
      apiKeyId: "key_1",
      orgId: "org_1",
      workspaceId: "ws_1",
    });
    const res = await appWithAuth().request("/whoami", {
      headers: { authorization: "Bearer oxk_live_abc" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: null,
      apiKeyId: "key_1",
      orgId: "org_1",
      workspaceId: "ws_1",
    });
    expect(mocks.resolveApiKey).toHaveBeenCalledWith("oxk_live_abc");
    expect(mocks.resolveSession).not.toHaveBeenCalled();
  });

  it("binds a session's user and no API key", async () => {
    mocks.resolveSession.mockResolvedValueOnce({ userId: "user_1" });
    const res = await appWithAuth().request("/whoami", {
      headers: { cookie: "session=tok" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      userId: "user_1",
      apiKeyId: null,
    });
  });

  it("answers 401 for a refused key, an expired session and no credentials", async () => {
    mocks.resolveApiKey.mockResolvedValueOnce({ ok: false, kind: "expired" });
    const expiredKey = await appWithAuth().request("/whoami", {
      headers: { authorization: "Bearer oxk_live_old" },
    });
    expect(expiredKey.status).toBe(401);
    expect(await expiredKey.text()).toBe("API key expired");

    mocks.resolveSession.mockResolvedValueOnce(null);
    const expiredSession = await appWithAuth().request("/whoami", {
      headers: { cookie: "session=stale" },
    });
    expect(expiredSession.status).toBe(401);

    const none = await appWithAuth().request("/whoami");
    expect(none.status).toBe(401);
  });

  it("answers 403 with the SSO message for a key its organization's Require SSO refuses", async () => {
    // The key is genuine, so this is not a 401: the CLI reads 401 as "this
    // key is not valid" and 403 as "the key is real, access is refused".
    mocks.resolveApiKey.mockResolvedValueOnce({
      ok: false,
      kind: "sso_required",
    });
    const res = await appWithAuth().request("/whoami", {
      headers: { authorization: "Bearer oxk_live_member" },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe(
      "This organization requires single sign-on. The person who created this key must sign in through SSO.",
    );
  });

  it("answers 403 host_revoked for a revoked Tacho host's retired key", async () => {
    // The shipper keys on the reason: a 401 or a bare 403 is retried, and a
    // revocation never clears on a retry (#3944).
    mocks.resolveApiKey.mockResolvedValueOnce({
      ok: false,
      kind: "host_revoked",
    });
    // With the API's own error handler, which renders a HandlerError's
    // reason in the envelope.
    const app = appWithAuth();
    app.onError(errorMiddleware);
    const res = await app.request("/whoami", {
      headers: { authorization: "Bearer ox_retired_host_key" },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: { code: "forbidden", reason: "host_revoked" },
    });
  });
});
