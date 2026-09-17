/**
 * api-key.revoke-rotate.test.ts — unit tests for revokeApiKeyAction and
 * rotateApiKeyAction. createApiKeyAction is covered separately in
 * api-key.test.ts; these two share the same buildApiKeyCtx gate but weren't
 * covered yet.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@oxagen/handlers/register", () => ({}));

// `auth.api_keys` is policy class `standard`, so a key minted into a real
// workspace — every key `oxagen login` mints — was outside the org-only
// sentinel scope these actions used to invoke with, and the handler's
// withTenantDb lookup resolved it to undefined. The action now resolves the
// key's own workspace first, which is what this seam answers.
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

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@oxagen/oxagen", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSessionOrRedirect: vi.fn() }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: vi.fn(),
  assertOrgAdmin: vi.fn(),
}));
vi.mock("@oxagen/oxagen/contracts/api.key.revoke", () => ({
  apiKeyRevoke: {
    name: "revoke_api_key",
    input: { parse: (v: unknown) => v },
    output: { parse: (v: unknown) => v },
  },
}));
vi.mock("@oxagen/oxagen/contracts/api.key.rotate", () => ({
  apiKeyRotate: {
    name: "rotate_api_key",
    input: { parse: (v: unknown) => v },
    output: { parse: (v: unknown) => v },
  },
}));

import { revalidatePath } from "next/cache";
import { invoke } from "@oxagen/oxagen";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, assertOrgAdmin } from "@/lib/resolve-org";
import {
  revokeApiKeyAction,
  rotateApiKeyAction,
} from "@/app/[orgSlug]/developer/tokens/api-key";

const mockInvoke = vi.mocked(invoke);
const mockRevalidatePath = vi.mocked(revalidatePath);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSessionOrRedirect).mockResolvedValue({
    user: { id: "user-1" },
  } as never);
  vi.mocked(resolveOrg).mockResolvedValue({
    id: "org-1",
    slug: "acme",
  } as never);
  vi.mocked(assertOrgAdmin).mockResolvedValue(undefined);
  dbState.rows = [{ workspaceId: "ws-1" }];
});

describe("revokeApiKeyAction", () => {
  it("gates on org admin, calls revoke_api_key, and revalidates the tokens path", async () => {
    mockInvoke.mockResolvedValue({ ok: true });

    const result = await revokeApiKeyAction({
      orgSlug: "acme",
      keyPublicId: "key_1",
    });

    expect(assertOrgAdmin).toHaveBeenCalledWith("org-1", "user-1");
    expect(mockInvoke).toHaveBeenCalledWith(
      "revoke_api_key",
      { keyPublicId: "key_1" },
      expect.objectContaining({ orgId: "org-1", userId: "user-1" }),
      { surface: "agent" },
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/developer/tokens");
    expect(result).toEqual({ ok: true });
  });

  it("invokes inside the key's own workspace, not the org-only sentinel", async () => {
    mockInvoke.mockResolvedValue({ ok: true });
    dbState.rows = [{ workspaceId: "ws-of-the-key" }];

    await revokeApiKeyAction({ orgSlug: "acme", keyPublicId: "key_1" });

    const ctx = mockInvoke.mock.calls[0]![2] as { workspaceId: string };
    expect(ctx.workspaceId).toBe("ws-of-the-key");
    expect(ctx.workspaceId).not.toBe("00000000-0000-0000-0000-000000000000");
  });

  it("reports a key that is not in this org as not found, without invoking", async () => {
    dbState.rows = [];

    await expect(
      revokeApiKeyAction({ orgSlug: "acme", keyPublicId: "key_1" }),
    ).rejects.toThrow(/Not found/);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("denies a non-admin caller and never reaches invoke", async () => {
    vi.mocked(assertOrgAdmin).mockRejectedValue(new Error("NEXT_NOT_FOUND"));

    await expect(
      revokeApiKeyAction({ orgSlug: "acme", keyPublicId: "key_1" }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("rotateApiKeyAction", () => {
  it("calls rotate_api_key with the key's public id and optional new name", async () => {
    mockInvoke.mockResolvedValue({ publicId: "key_1", secret: "sk_live_new" });

    const result = await rotateApiKeyAction({
      orgSlug: "acme",
      keyPublicId: "key_1",
      name: "Renamed key",
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      "rotate_api_key",
      { keyPublicId: "key_1", name: "Renamed key" },
      expect.anything(),
      { surface: "agent" },
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/developer/tokens");
    expect(result).toEqual({ publicId: "key_1", secret: "sk_live_new" });
  });

  it("omits name when not provided", async () => {
    mockInvoke.mockResolvedValue({ publicId: "key_1", secret: "sk_live_new" });

    await rotateApiKeyAction({ orgSlug: "acme", keyPublicId: "key_1" });

    expect(mockInvoke).toHaveBeenCalledWith(
      "rotate_api_key",
      { keyPublicId: "key_1", name: undefined },
      expect.anything(),
      { surface: "agent" },
    );
  });

  it("rotates inside the rotated key's workspace, so the replacement keeps its scope", async () => {
    mockInvoke.mockResolvedValue({ publicId: "key_2", secret: "sk_live_new" });
    dbState.rows = [{ workspaceId: "ws-of-the-key" }];

    await rotateApiKeyAction({ orgSlug: "acme", keyPublicId: "key_1" });

    const ctx = mockInvoke.mock.calls[0]![2] as { workspaceId: string };
    expect(ctx.workspaceId).toBe("ws-of-the-key");
  });

  it("reports a key that is not in this org as not found, without invoking", async () => {
    dbState.rows = [];

    await expect(
      rotateApiKeyAction({ orgSlug: "acme", keyPublicId: "key_1" }),
    ).rejects.toThrow(/Not found/);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
