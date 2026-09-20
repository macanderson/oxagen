/**
 * Unit tests for the set_routing_policy handler's scope guard.
 *
 * The guard was `if (scope === "workspace" && !ctx.workspaceId)`, and the
 * org-only workspace sentinel is the nil uuid, which is truthy. A caller with
 * no workspace would therefore have sailed through and written a
 * `workspace.routing_policy` row whose workspace_id is a workspace no row
 * answers to — and the write would have succeeded, because the class's WITH
 * CHECK compares the row's workspace_id to the workspace GUC and both hold the
 * sentinel. The policy would then read as a saved workspace policy and apply to
 * nothing.
 *
 * No call site reaches that today: every caller passes a real workspace id, and
 * `routing_policy.workspace_id` is elsewhere only ever a filter
 * (./lib/routing-policy.ts). These tests are why the guard stays.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Authorization behavior is exercised with real guards in role-enforcement.regression.test.ts.
vi.mock("@oxagen/iam/org-role", () => ({
  assertOrgRole: vi.fn(async () => "Owner"),
  resolveActingUserId: vi.fn(
    async (ctx: { userId: string | null }) => ctx.userId,
  ),
}));
import { ORG_ONLY_WORKSPACE_ID } from "@oxagen/oxagen";
import type { CapabilityContext } from "@oxagen/oxagen";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  withOrgDb: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: mocks.withTenantDb,
    withOrgDb: mocks.withOrgDb,
  };
});

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { routerPolicySetHandler } from "./router.policy.set";

function ctx(workspaceId: string | null): CapabilityContext {
  return {
    orgId: "11111111-1111-1111-1111-111111111111",
    workspaceId,
    userId: "22222222-2222-2222-2222-222222222222",
    apiKeyId: null,
    requestId: "req-1",
    surface: "api",
    messageId: null,
  } as unknown as CapabilityContext;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("set_routing_policy scope guard", () => {
  it("refuses workspace scope carrying the org-only sentinel", async () => {
    await expect(
      routerPolicySetHandler(
        { scope: "workspace", mode: "off" } as never,
        ctx(ORG_ONLY_WORKSPACE_ID),
      ),
    ).rejects.toThrow(/requires a workspace context/);
    // Nothing is read and nothing is written, by either seam.
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.withOrgDb).not.toHaveBeenCalled();
  });

  it("refuses workspace scope carrying no workspace at all", async () => {
    await expect(
      routerPolicySetHandler(
        { scope: "workspace", mode: "off" } as never,
        ctx(null),
      ),
    ).rejects.toThrow(/requires a workspace context/);
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.withOrgDb).not.toHaveBeenCalled();
  });

  it("refuses the default scope, which is workspace, on a sentinel context", async () => {
    await expect(
      routerPolicySetHandler(
        { mode: "off" } as never,
        ctx(ORG_ONLY_WORKSPACE_ID),
      ),
    ).rejects.toThrow(/requires a workspace context/);
  });

  // The org row is reached through withOrgDb, never withTenantDb (ADR-086).
  // `workspace.routing_policy` is `workspace_nullable`, so its policy names the
  // workspace GUC — and under the org-only sentinel that GUC is not a uuid, so
  // a withTenantDb statement against this table refuses with 22P02 before it
  // reads anything. Asserting withTenantDb was NOT used is the half of this
  // test that would otherwise pass on the seam that cannot work.
  it("admits org scope on a sentinel context through withOrgDb — the org row carries workspace_id NULL", async () => {
    const insertValues = vi.fn().mockResolvedValue([]);
    mocks.withOrgDb.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          query: { routingPolicy: { findFirst: () => Promise.resolve(null) } },
          insert: () => ({ values: insertValues }),
        }),
    );

    await routerPolicySetHandler(
      { scope: "org", mode: "off" } as never,
      ctx(ORG_ONLY_WORKSPACE_ID),
    );

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: null }),
    );
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("admits workspace scope on a real workspace id", async () => {
    const updateWhere = vi.fn().mockResolvedValue([]);
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          query: {
            routingPolicy: {
              findFirst: () =>
                Promise.resolve({ id: "rp-1", mode: "off", minSamples: 20 }),
            },
          },
          update: () => ({ set: () => ({ where: updateWhere }) }),
        }),
    );

    await routerPolicySetHandler(
      { scope: "workspace", mode: "off" } as never,
      ctx("33333333-3333-3333-3333-333333333333"),
    );

    expect(updateWhere).toHaveBeenCalled();
    // And NOT through withOrgDb: that seam leaves the workspace GUC empty, so
    // a row naming a workspace would fail WITH CHECK with 42501.
    expect(mocks.withOrgDb).not.toHaveBeenCalled();
  });
});
