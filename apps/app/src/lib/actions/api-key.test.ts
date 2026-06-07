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
}));

vi.mock("@oxagen/oxagen", () => ({
  invoke: vi.fn(),
}));

vi.mock("@oxagen/handlers/register", () => ({}));

vi.mock("@oxagen/oxagen/contracts/api.key.create", () => ({
  apiKeyCreate: {
    name: "api.key.create",
    input: { parse: (v: unknown) => v },
    output: { parse: (v: unknown) => v },
  },
}));

import { createApiKeyAction } from "./api-key";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg } from "@/lib/resolve-org";
import { invoke } from "@oxagen/oxagen";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const mockSession = { user: { id: "user-1" } };
const mockOrg = { id: "org-abc", publicId: "pub-org", name: "Acme", slug: "acme" };
const mockApiKey = { id: "key-1", token: "oxg_key_abc123", name: "CI Key" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("createApiKeyAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionOrRedirect).mockResolvedValue(mockSession as never);
    vi.mocked(resolveOrg).mockResolvedValue(mockOrg as never);
    vi.mocked(invoke).mockResolvedValue(mockApiKey);
  });

  it("invokes api.key.create capability", async () => {
    await createApiKeyAction({ orgSlug: "acme", name: "CI Key" });
    const [capName] = vi.mocked(invoke).mock.calls[0]!;
    expect(capName).toBe("api.key.create");
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
    expect((input as { expiresAt: string }).expiresAt).toBe("2027-01-01T00:00:00.000Z");
  });

  it("uses org-only sentinel workspace id in ctx", async () => {
    await createApiKeyAction({ orgSlug: "acme", name: "Key" });
    const [, , ctx] = vi.mocked(invoke).mock.calls[0]!;
    expect(ctx.workspaceId).toBe("00000000-0000-0000-0000-000000000000");
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
    vi.mocked(getSessionOrRedirect).mockRejectedValue(new Error("unauthenticated"));
    await expect(createApiKeyAction({ orgSlug: "acme", name: "Key" })).rejects.toThrow(
      "unauthenticated",
    );
  });

  it("propagates errors from resolveOrg", async () => {
    vi.mocked(resolveOrg).mockRejectedValue(new Error("org not found"));
    await expect(createApiKeyAction({ orgSlug: "bad-org", name: "Key" })).rejects.toThrow(
      "org not found",
    );
  });

  it("propagates errors from invoke", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("handler error"));
    await expect(createApiKeyAction({ orgSlug: "acme", name: "Key" })).rejects.toThrow(
      "handler error",
    );
  });
});
