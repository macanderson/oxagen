import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock @oxagen/database so the service is unit-testable without a live DB.
const rows: Record<string, unknown>[] = [];
vi.mock("@oxagen/database", () => ({
  schema: {
    mcpCredentials: {
      id: "id",
      workspaceId: "workspace_id",
      orgListingId: "org_listing_id",
    },
  },
  withSystemDb: async (fn: (tx: unknown) => unknown) => fn(makeTx()),
}));

function makeTx() {
  return {
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            rows.push(v);
            return [{ id: "cred-1" }];
          },
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (rows.length ? [rows[rows.length - 1]] : []),
        }),
      }),
    }),
  };
}

beforeEach(() => {
  rows.length = 0;
  process.env.AUTH_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
});

describe("workspace-credential", () => {
  it("encrypts a secret on set (no plaintext stored) and decrypts on get", async () => {
    const { setWorkspaceSecret, getWorkspaceSecret } = await import("./workspace-credential");
    await setWorkspaceSecret({
      orgId: "o1",
      workspaceId: "w1",
      orgListingId: "l1",
      authKind: "secret",
      secret: "sk-xyz",
    });
    const stored = rows[rows.length - 1]!;
    expect(stored.secretEnc).toBeInstanceOf(Buffer);
    expect(JSON.stringify(Array.from(stored.secretEnc as Buffer))).not.toContain("sk-xyz");
    expect(JSON.stringify(stored)).not.toContain("sk-xyz");

    const got = await getWorkspaceSecret({ orgId: "o1", workspaceId: "w1", orgListingId: "l1" });
    expect(got?.secret).toBe("sk-xyz");
    expect(got?.authKind).toBe("secret");
  });

  it("round-trips oauth access + refresh tokens", async () => {
    const { setWorkspaceSecret, getWorkspaceSecret } = await import("./workspace-credential");
    await setWorkspaceSecret({
      orgId: "o1",
      workspaceId: "w1",
      orgListingId: "l2",
      authKind: "oauth",
      accessToken: "at-1",
      refreshToken: "rt-1",
    });
    const got = await getWorkspaceSecret({ orgId: "o1", workspaceId: "w1", orgListingId: "l2" });
    expect(got?.accessToken).toBe("at-1");
    expect(got?.refreshToken).toBe("rt-1");
  });
});
