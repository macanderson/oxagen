/**
 * api-key.test.ts — unit tests for createApiKeyAction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock("@/lib/session", () => ({
  getSessionOrRedirect: vi.fn(),
}));

vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: vi.fn(),
  getOrgRole: vi.fn().mockResolvedValue("owner"),
  assertOrgAdmin: vi.fn(),
}));

vi.mock("@oxagen/oxagen", () => ({
  invoke: vi.fn(),
}));

vi.mock("@oxagen/handlers/register", () => ({}));

// The three actions each resolve a real workspace before invoking, so the
// database seam has to answer here. `withSystemDb` is the only seam mocked:
// this module reads `auth.api_keys` (policy class `standard`) and
// `workspace.workspaces` at the organization level, where there is no workspace
// scope to read them under.
const { dbState } = vi.hoisted(() => ({
  dbState: { rows: [] as Array<Record<string, unknown>> },
}));
vi.mock("@oxagen/database", () => {
  const chain = () => {
    const self: Record<string, unknown> = {};
    for (const m of ["from", "innerJoin", "where", "orderBy"]) {
      self[m] = () => self;
    }
    self.limit = () => Promise.resolve(dbState.rows);
    return self;
  };
  return {
    withSystemDb: vi.fn((fn: (tx: unknown) => unknown) =>
      fn({ select: () => chain() }),
    ),
    schema: {
      apiKeys: {
        orgId: "orgId",
        publicId: "publicId",
        workspaceId: "workspaceId",
        deletedAt: "deletedAt",
      },
      workspaces: { id: "id", orgId: "orgId", createdAt: "createdAt" },
      workspaceUsers: { workspaceId: "workspaceId", userId: "userId" },
    },
  };
});
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  asc: (a: unknown) => a,
  eq: (a: unknown, b: unknown) => [a, b],
  isNull: (a: unknown) => a,
}));

// revalidatePath touches Next's static-generation store, which only exists
// during a request. In a unit test it throws "Invariant: static generation
// store missing" — mock it to a no-op so the action's cache-busting side
// effect doesn't break the capability-invocation assertions.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@oxagen/oxagen/contracts/api.key.create", () => ({
  apiKeyCreate: {
    name: "create_api_key",
    input: { parse: (v: unknown) => v },
    output: { parse: (v: unknown) => v },
  },
}));

import { createApiKeyAction } from "./api-key";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, assertOrgAdmin } from "@/lib/resolve-org";
import { invoke } from "@oxagen/oxagen";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const mockSession = { user: { id: "user-1" } };
const mockOrg = {
  id: "org-abc",
  publicId: "pub-org",
  name: "Acme",
  slug: "acme",
};
const mockApiKey = { id: "key-1", token: "oxg_key_abc123", name: "CI Key" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("createApiKeyAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionOrRedirect).mockResolvedValue(mockSession as never);
    vi.mocked(resolveOrg).mockResolvedValue(mockOrg as never);
    vi.mocked(assertOrgAdmin).mockResolvedValue(undefined);
    vi.mocked(invoke).mockResolvedValue(mockApiKey);
    dbState.rows = [{ id: "ws-1" }];
  });

  it("invokes api.key.create capability", async () => {
    await createApiKeyAction({ orgSlug: "acme", name: "CI Key" });
    const [capName] = vi.mocked(invoke).mock.calls[0]!;
    expect(capName).toBe("create_api_key");
  });

  it("passes name to the capability input", async () => {
    await createApiKeyAction({ orgSlug: "acme", name: "Deploy Key" });
    const [, input] = vi.mocked(invoke).mock.calls[0]!;
    expect((input as { name: string }).name).toBe("Deploy Key");
  });

  it("passes expiresAt when provided", async () => {
    await createApiKeyAction({
      orgSlug: "acme",
      name: "Expiring Key",
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
    const [, input] = vi.mocked(invoke).mock.calls[0]!;
    expect((input as { expiresAt: string }).expiresAt).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });

  // This used to assert the opposite, and the assertion was the bug written
  // down. `create_api_key` persists ctx.workspaceId, and the nil sentinel
  // satisfies the `standard` policy's WITH CHECK because the row carries the
  // same value the GUC holds — so the insert succeeded and the secret shown
  // once named a workspace no row answers to. Such a key authenticates into
  // nothing (ADR-073, #3116).
  it("mints into a real workspace, never the org-only sentinel", async () => {
    await createApiKeyAction({ orgSlug: "acme", name: "Key" });
    const [, , ctx] = vi.mocked(invoke).mock.calls[0]!;
    expect(ctx.workspaceId).toBe("ws-1");
    expect(ctx.workspaceId).not.toBe("00000000-0000-0000-0000-000000000000");
  });

  it("refuses to mint when the actor belongs to no workspace in this org", async () => {
    dbState.rows = [];
    await expect(
      createApiKeyAction({ orgSlug: "acme", name: "Key" }),
    ).rejects.toThrow(/No workspace to mint this key into/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("wires orgId and userId into ctx", async () => {
    await createApiKeyAction({ orgSlug: "acme", name: "Key" });
    const [, , ctx] = vi.mocked(invoke).mock.calls[0]!;
    expect(ctx.orgId).toBe("org-abc");
    expect(ctx.userId).toBe("user-1");
    expect(ctx.surface).toBe("app");
    expect(ctx.apiKeyId).toBeNull();
  });

  it("returns the parsed output from invoke", async () => {
    const result = await createApiKeyAction({ orgSlug: "acme", name: "Key" });
    expect(result).toEqual(mockApiKey);
  });

  it("propagates errors from getSessionOrRedirect", async () => {
    vi.mocked(getSessionOrRedirect).mockRejectedValue(
      new Error("unauthenticated"),
    );
    await expect(
      createApiKeyAction({ orgSlug: "acme", name: "Key" }),
    ).rejects.toThrow("unauthenticated");
  });

  it("propagates errors from resolveOrg", async () => {
    vi.mocked(resolveOrg).mockRejectedValue(new Error("org not found"));
    await expect(
      createApiKeyAction({ orgSlug: "bad-org", name: "Key" }),
    ).rejects.toThrow("org not found");
  });

  it("propagates errors from invoke", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("handler error"));
    await expect(
      createApiKeyAction({ orgSlug: "acme", name: "Key" }),
    ).rejects.toThrow("handler error");
  });

  it("gates on org admin: asserts before touching the capability", async () => {
    await createApiKeyAction({ orgSlug: "acme", name: "Key" });
    expect(assertOrgAdmin).toHaveBeenCalledWith("org-abc", "user-1");
  });

  it("denies a non-admin caller and never reaches invoke (IDOR guard)", async () => {
    // assertOrgAdmin calls notFound() for a non-admin/non-member, which throws.
    vi.mocked(assertOrgAdmin).mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(
      createApiKeyAction({ orgSlug: "acme", name: "Key" }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(invoke).not.toHaveBeenCalled();
  });
});
