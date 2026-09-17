import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../../app";

// `capabilityContext` is deliberately NOT mocked: the defect these routes had
// lived inside it. Every other thin-route test stubs it out and mounts the
// route on a context that already carries an org, which is exactly why four
// routes could return 400 for every real session user with a green suite.
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));

import { budgetPolicyReadRoute } from "./budget.policy.read";
import { budgetPolicyWriteRoute } from "./budget.policy.write";
import { userPreferencesReadRoute } from "./user.preferences.read";
import { userPreferencesSetRoute } from "./user.preferences.set";

/**
 * What `userScoped` in app.ts actually is: `authMiddleware` and nothing else.
 * It sets `userId` and never an org or workspace, which is the whole point —
 * these four capabilities are `scoped: false` because they are user-global,
 * and one of them is reachable before the user belongs to any organization.
 */
function userScopedApp(path: string, route: Hono<AppEnv>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("userId", "user_1");
    c.set("requestId", "11111111-1111-4111-8111-111111111111");
    await next();
  });
  app.route(path, route);
  return app;
}

const CASES = [
  {
    name: "GET /user/preferences/read",
    path: "/user/preferences/read",
    route: userPreferencesReadRoute,
    request: () => new Request("http://localhost/user/preferences/read"),
    output: { locale: "en", theme: "system", timezone: "UTC" },
  },
  {
    name: "PATCH /user/preferences",
    path: "/user/preferences",
    route: userPreferencesSetRoute,
    request: () =>
      new Request("http://localhost/user/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ theme: "dark" }),
      }),
    output: { locale: "en", theme: "dark", timezone: "UTC" },
  },
  {
    name: "GET /user/budget/read",
    path: "/user/budget/read",
    route: budgetPolicyReadRoute,
    request: () => new Request("http://localhost/user/budget/read"),
    output: {
      enabled: false,
      limitUsd: null,
      mode: "soft",
      graceOveragePct: 0,
      enforcement: "default",
    },
  },
  {
    name: "PATCH /user/budget/write",
    path: "/user/budget/write",
    route: budgetPolicyWriteRoute,
    request: () =>
      new Request("http://localhost/user/budget/write", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
    output: {
      enabled: false,
      limitUsd: null,
      mode: "soft",
      graceOveragePct: 0,
      enforcement: "default",
    },
  },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("user-global routes on the unscoped router", () => {
  for (const c of CASES) {
    it(`${c.name} answers a session user who has no organization`, async () => {
      mocks.invoke.mockResolvedValue(c.output);
      const res = await userScopedApp(c.path, c.route as Hono<AppEnv>).fetch(
        c.request(),
      );
      expect(res.status).toBe(200);
      expect(mocks.invoke).toHaveBeenCalledTimes(1);
    });

    it(`${c.name} builds a context with no org and no workspace`, async () => {
      mocks.invoke.mockResolvedValue(c.output);
      await userScopedApp(c.path, c.route as Hono<AppEnv>).fetch(c.request());
      // The org-only sentinel is for a route mounted org-only reaching a
      // scoped capability. These are user-global, so neither id is invented.
      const ctx = mocks.invoke.mock.calls[0]![2] as {
        orgId: string;
        workspaceId: string;
        userId: string | null;
      };
      expect(ctx.orgId).toBe("");
      expect(ctx.workspaceId).toBe("");
      expect(ctx.userId).toBe("user_1");
    });
  }
});
