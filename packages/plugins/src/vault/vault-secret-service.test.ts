import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_VAULT_KEY_ID } from "./vault-kms";

// Mock @oxagen/database so the vault service's crypto/storage logic is testable
// without a live DB. We keep the real `schema` and only replace `withTenantDb`
// with a fake tx: every `select` returns "no existing key" (a fresh insert
// path) and we capture the `insert().values()` payload to assert the
// sensitive→encrypted vs plaintext storage-column split. Real @oxagen/crypto is
// used (not mocked) so encryption is exercised end-to-end.
interface Captures {
  inserts: { values: Record<string, unknown> }[];
}
const state: Captures = { inserts: [] };

function makeTx() {
  const selectBuilder = () => {
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      from: () => b,
      where: () => b,
      limit: async () => [], // no existing key → insert path
      orderBy: async () => [],
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve([]).then(res, rej),
    });
    return b;
  };
  return {
    select: () => selectBuilder(),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        state.inserts.push({ values: v });
        return {
          returning: async () => [{ publicId: "sk_pub_1" }],
        };
      },
    }),
  };
}

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => unknown) => fn(makeTx()),
  };
});

const actor = { orgId: "o1", workspaceId: "w1", userId: "u1" };

beforeEach(() => {
  state.inserts = [];
  process.env.AUTH_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString(
    "base64",
  );
});

describe("upsertSecretKey — storage column split", () => {
  it("envelope-encrypts a sensitive default (no plaintext in storage columns)", async () => {
    const { upsertSecretKey } = await import("./vault-secret-service");
    const result = await upsertSecretKey(actor, {
      key: "API_KEY",
      sensitive: true,
      defaultValue: "super-secret-value",
    });
    expect(result.id).toBe("sk_pub_1");

    const stored = state.inserts[state.inserts.length - 1]!.values;
    // Sensitive: the encrypted blob is populated, the plaintext column is null.
    expect(stored.defaultValueEnc).toBeInstanceOf(Buffer);
    expect(stored.defaultValueText).toBeNull();
    expect(stored.defaultValueKmsKeyId).toBe(WORKSPACE_VAULT_KEY_ID);
    // The plaintext must never appear anywhere in the stored row.
    expect(JSON.stringify(stored)).not.toContain("super-secret-value");
    expect(
      JSON.stringify(Array.from(stored.defaultValueEnc as Buffer)),
    ).not.toContain("super-secret-value");
  });

  it("stores a non-sensitive default as plaintext config (no encryption)", async () => {
    const { upsertSecretKey } = await import("./vault-secret-service");
    await upsertSecretKey(actor, {
      key: "LOG_LEVEL",
      sensitive: false,
      defaultValue: "debug",
    });
    const stored = state.inserts[state.inserts.length - 1]!.values;
    expect(stored.defaultValueText).toBe("debug");
    expect(stored.defaultValueEnc).toBeNull();
    expect(stored.defaultValueKmsKeyId).toBeNull();
  });

  it("rejects an invalid secret key name before any write", async () => {
    const { upsertSecretKey } = await import("./vault-secret-service");
    await expect(
      upsertSecretKey(actor, { key: "1-bad-name", sensitive: true }),
    ).rejects.toThrow(/invalid secret key name/);
    expect(state.inserts).toHaveLength(0);
  });
});

describe("VaultLockedError — missing master key", () => {
  it("throws when a sensitive value must be encrypted but no master key is set", async () => {
    delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
    vi.resetModules();
    const { upsertSecretKey } = await import("./vault-secret-service");
    const { VaultLockedError } = await import("./vault-kms");
    await expect(
      upsertSecretKey(actor, {
        key: "API_KEY",
        sensitive: true,
        defaultValue: "needs-encryption",
      }),
    ).rejects.toBeInstanceOf(VaultLockedError);
    expect(state.inserts).toHaveLength(0);
  });

  it("does NOT require a master key for a non-sensitive value", async () => {
    delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
    vi.resetModules();
    const { upsertSecretKey } = await import("./vault-secret-service");
    await expect(
      upsertSecretKey(actor, {
        key: "PUBLIC_FLAG",
        sensitive: false,
        defaultValue: "on",
      }),
    ).resolves.toEqual({ id: "sk_pub_1" });
    const stored = state.inserts[state.inserts.length - 1]!.values;
    expect(stored.defaultValueText).toBe("on");
  });
});
