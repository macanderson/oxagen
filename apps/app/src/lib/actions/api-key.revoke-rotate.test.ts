/**
 * api-key.revoke-rotate.test.ts — unit tests for revokeApiKeyAction and
 * rotateApiKeyAction. createApiKeyAction is covered separately in
 * api-key.test.ts; these two share the same buildApiKeyCtx gate but weren't
 * covered yet.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@oxagen/handlers/register", () => ({}));
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
import { revokeApiKeyAction, rotateApiKeyAction } from "./api-key";

const mockInvoke = vi.mocked(invoke);
const mockRevalidatePath = vi.mocked(revalidatePath);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSessionOrRedirect).mockResolvedValue({ user: { id: "user-1" } } as never);
  vi.mocked(resolveOrg).mockResolvedValue({ id: "org-1", slug: "acme" } as never);
  vi.mocked(assertOrgAdmin).mockResolvedValue(undefined);
});

describe("revokeApiKeyAction", () => {
  it("gates on org admin, calls revoke_api_key, and revalidates the tokens path", async () => {
    mockInvoke.mockResolvedValue({ ok: true });

    const result = await revokeApiKeyAction({ orgSlug: "acme", keyPublicId: "key_1" });

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

  it("denies a non-admin caller and never reaches invoke", async () => {
    vi.mocked(assertOrgAdmin).mockRejectedValue(new Error("NEXT_NOT_FOUND"));

    await expect(revokeApiKeyAction({ orgSlug: "acme", keyPublicId: "key_1" })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
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
});
