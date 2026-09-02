import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock @oxagen/database so the service is unit-testable without a live DB.
const rows: Record<string, unknown>[] = [];
// Captures the `set` clause passed to onConflictDoUpdate for partial-update assertions.
const conflictSets: Record<string, unknown>[] = [];
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: async (fn: (tx: unknown) => unknown) => fn(makeTx()),
  };
});

function makeTx() {
  return {
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoUpdate: (o: { set: Record<string, unknown> }) => ({
          returning: async () => {
            rows.push(v);
            conflictSets.push(o.set);
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
  conflictSets.length = 0;
  process.env.AUTH_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString(
    "base64",
  );
});

describe("workspace-credential", () => {
  it("encrypts a secret on set (no plaintext stored) and decrypts on get", async () => {
    const { setWorkspaceSecret, getWorkspaceSecret } = await import(
      "./workspace-credential"
    );
    await setWorkspaceSecret({
      orgId: "o1",
      workspaceId: "w1",
      orgListingId: "l1",
      authKind: "secret",
      secret: "sk-xyz",
    });
    const stored = rows[rows.length - 1]!;
    expect(stored.secretEnc).toBeInstanceOf(Buffer);
    expect(
      JSON.stringify(Array.from(stored.secretEnc as Buffer)),
    ).not.toContain("sk-xyz");
    expect(JSON.stringify(stored)).not.toContain("sk-xyz");

    const got = await getWorkspaceSecret({
      orgId: "o1",
      workspaceId: "w1",
      orgListingId: "l1",
    });
    expect(got?.secret).toBe("sk-xyz");
    expect(got?.authKind).toBe("secret");
  });

  it("round-trips oauth access + refresh tokens", async () => {
    const { setWorkspaceSecret, getWorkspaceSecret } = await import(
      "./workspace-credential"
    );
    await setWorkspaceSecret({
      orgId: "o1",
      workspaceId: "w1",
      orgListingId: "l2",
      authKind: "oauth",
      accessToken: "at-1",
      refreshToken: "rt-1",
    });
    const got = await getWorkspaceSecret({
      orgId: "o1",
      workspaceId: "w1",
      orgListingId: "l2",
    });
    expect(got?.accessToken).toBe("at-1");
    expect(got?.refreshToken).toBe("rt-1");
  });

  it("getWorkspaceSecret returns null AND logs console.error when AUTH_TOKEN_ENCRYPTION_KEY is absent", async () => {
    // A missing KMS key makes every credential unreadable. Returning null is
    // type-identical to 'no row', so the misconfiguration must be surfaced.
    delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    // Reset modules so the module-level kmsAbsentWarned flag starts fresh.
    vi.resetModules();
    const { getWorkspaceSecret } = await import("./workspace-credential");
    try {
      const got = await getWorkspaceSecret({
        orgId: "o1",
        workspaceId: "w1",
        orgListingId: "l1",
      });
      expect(got).toBeNull();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [msg] = errorSpy.mock.calls[0] as [string, ...unknown[]];
      expect(msg).toContain("AUTH_TOKEN_ENCRYPTION_KEY is not set");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("logs the missing-key warning at most once per process (no log spam)", async () => {
    delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.resetModules();
    const { getWorkspaceSecret } = await import("./workspace-credential");
    try {
      await getWorkspaceSecret({
        orgId: "o1",
        workspaceId: "w1",
        orgListingId: "l1",
      });
      await getWorkspaceSecret({
        orgId: "o1",
        workspaceId: "w1",
        orgListingId: "l2",
      });
      await getWorkspaceSecret({
        orgId: "o1",
        workspaceId: "w1",
        orgListingId: "l3",
      });
      // Three reads, but only one error logged — the module-level guard holds.
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
