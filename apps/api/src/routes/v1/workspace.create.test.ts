/**
 * The REST surface must be able to create a new account's FIRST workspace.
 *
 * `workspaceCreateRoute` was mounted only inside the workspace-scoped group, so
 * every attempt needed a workspace slug in the path that the account did not
 * have yet. It 404'd in `workspaceMiddleware` before the handler ran, and the
 * only way to bootstrap an account was the web UI's server action (#1203).
 *
 * These drive the route directly with the two scope shapes rather than booting
 * the whole app: the fix is the route's context requirement plus where it is
 * mounted, and the first half is what a request actually hits.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@oxagen/oxagen/kernel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen/kernel")>()),
  invoke: mocks.invoke,
}));

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { workspaceCreateRoute } from "./workspace.create";
import type { AppEnv } from "../../app";

/** Mount the real route under a scope, the way app.ts does. */
function mount(scope: Partial<AppEnv["Variables"]>) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (scope.orgId !== undefined) c.set("orgId", scope.orgId);
    if (scope.workspaceId !== undefined)
      c.set("workspaceId", scope.workspaceId);
    if (scope.userId !== undefined) c.set("userId", scope.userId);
    await next();
  });
  app.onError((err, c) =>
    err instanceof HTTPException
      ? c.json({ error: err.message }, err.status)
      : c.json({ error: "internal" }, 500),
  );
  app.route("/workspaces", workspaceCreateRoute);
  return app;
}

function post(app: Hono<AppEnv>) {
  return app.fetch(
    new Request("http://localhost/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "First", slug: "first" }),
    }),
  );
}

describe("creating the first workspace over REST (#1203)", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue({ id: "ws_1", slug: "first" });
  });

  it("reaches the handler with an org and no workspace", async () => {
    // The bootstrap case. This is what returned 400 before the route stopped
    // demanding a workspace it is being asked to create.
    const res = await post(
      mount({ orgId: "org_1", workspaceId: null, userId: "u1" }),
    );
    expect(res.status).toBe(201);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    const [, , ctx] = mocks.invoke.mock.calls[0] as [
      string,
      unknown,
      { orgId: string },
    ];
    expect(ctx.orgId).toBe("org_1");
  });

  it("still works from the workspace-scoped mount, which was not removed", async () => {
    const res = await post(
      mount({ orgId: "org_1", workspaceId: "ws_0", userId: "u1" }),
    );
    expect(res.status).toBe(201);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("refuses when there is no org either, rather than inventing a tenant", async () => {
    const res = await post(
      mount({ orgId: null, workspaceId: null, userId: "u1" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
