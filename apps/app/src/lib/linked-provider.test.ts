/**
 * linked-provider.test.ts — unit tests for getLinkedSocialProvider.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted stubs
// ---------------------------------------------------------------------------
const { mockRows, mockWithSystemDb } = vi.hoisted(() => {
  const mockRows: { providerId: string }[] = [];
  const mockWhere = vi.fn(() => Promise.resolve(mockRows));
  const mockFrom = vi.fn(() => ({ where: mockWhere }));
  const mockSelect = vi.fn(() => ({ from: mockFrom }));
  const mockTx = { select: mockSelect };
  const mockWithSystemDb = vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(mockTx));
  return { mockRows, mockWithSystemDb };
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock("server-only", () => ({}));

vi.mock("@oxagen/database", () => ({
  withSystemDb: mockWithSystemDb,
  schema: {
    accounts: {
      userId: "user_id_col",
      providerId: "provider_id_col",
    },
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

import { getLinkedSocialProvider } from "./linked-provider";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setProviders(providers: string[]) {
  mockRows.length = 0;
  mockRows.push(...providers.map((providerId) => ({ providerId })));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("getLinkedSocialProvider", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 'google' when Google provider is linked", async () => {
    setProviders(["google"]);
    expect(await getLinkedSocialProvider("user-1")).toBe("google");
  });

  it("returns 'github' when only GitHub provider is linked", async () => {
    setProviders(["github"]);
    expect(await getLinkedSocialProvider("user-1")).toBe("github");
  });

  it("prefers 'google' over 'github' when both are linked", async () => {
    setProviders(["github", "google"]);
    expect(await getLinkedSocialProvider("user-1")).toBe("google");
  });

  it("returns null when only credential provider is linked", async () => {
    setProviders(["credential"]);
    expect(await getLinkedSocialProvider("user-1")).toBeNull();
  });

  it("returns null when no providers are linked", async () => {
    setProviders([]);
    expect(await getLinkedSocialProvider("user-1")).toBeNull();
  });

  it("returns null when unknown provider is linked (e.g. email)", async () => {
    setProviders(["email"]);
    expect(await getLinkedSocialProvider("user-1")).toBeNull();
  });

  it("handles multiple credential rows, returns google if present", async () => {
    setProviders(["credential", "google", "github"]);
    expect(await getLinkedSocialProvider("user-1")).toBe("google");
  });
});
