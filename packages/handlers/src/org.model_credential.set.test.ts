import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  insert: vi.fn(),
  invalidate: vi.fn(),
  resolveKms: vi.fn(),
  emit: vi.fn(),
  encrypt: vi.fn(),
  withTenantDb: vi.fn(),
}));

/** Minimal Drizzle chain doubles: .update().set().where().returning() etc. */
function makeTx() {
  return {
    query: { modelCredentials: { findFirst: mocks.findFirst } },
    update: () => ({
      set: (values: unknown) => ({
        where: () => ({
          returning: async () => {
            mocks.update(values);
            return [{ ...(values as object), id: "row-1" }];
          },
        }),
      }),
    }),
    insert: () => ({
      values: (values: unknown) => ({
        returning: async () => {
          mocks.insert(values);
          return [{ ...(values as object), id: "row-1" }];
        },
      }),
    }),
  };
}

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withTenantDb: mocks.withTenantDb,
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});
vi.mock("@oxagen/database/model-credential", () => ({
  invalidateModelCredentialCache: mocks.invalidate,
  resolveModelCredentialKms: mocks.resolveKms,
}));
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emit,
}));
vi.mock("@oxagen/crypto", () => ({
  encrypt: async (plaintext: string, keyId: string) => {
    mocks.encrypt(plaintext, keyId);
    return Buffer.from(`enc(${plaintext.length})`);
  },
}));

import {
  keyDigest,
  keyHintOf,
  orgModelCredentialSetHandler,
} from "./org.model_credential.set";
// The org-role gate every model-credential handler asserts (INV-29). Allows
// by default — an org Admin — so each case below tests its own behaviour;
// the refusal cases set `roleGate.refuse` and assert nothing else ran.
const roleGate = vi.hoisted(() => ({
  refuse: false,
  assertOrgRole: vi.fn(),
}));
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: async (ctx: { userId?: string | null }) =>
    ctx.userId ?? null,
  assertOrgRole: roleGate.assertOrgRole.mockImplementation(async () => {
    if (roleGate.refuse) {
      throw Object.assign(new Error("forbidden: org role required"), {
        code: "forbidden",
      });
    }
    return "Admin";
  }),
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
}));

import { orgModelCredentialSet } from "@oxagen/oxagen/contracts/org.model_credential.set";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

const API_KEY = "sk-or-v1-super-secret-0123456789wxyz";
const INPUT = { provider: "openrouter" as const, apiKey: API_KEY };

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.withTenantDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx()),
  );
  mocks.resolveKms.mockReturnValue({
    adapter: {},
    keyId: "model_credential_v1",
  });
});

describe("keyDigest", () => {
  it("is the hex sha-256 of the key, never the key", () => {
    const expected = createHash("sha256").update(API_KEY).digest("hex");
    expect(keyDigest(API_KEY)).toBe(expected);
    expect(keyDigest(API_KEY)).toMatch(/^[0-9a-f]{64}$/);
    expect(keyDigest(API_KEY)).not.toContain("super-secret");
  });

  it("changes when the key rotates (so the client cache misses)", () => {
    expect(keyDigest(API_KEY)).not.toBe(keyDigest(`${API_KEY}-rotated`));
  });
});

describe("keyHintOf", () => {
  it("is the last four characters and nothing more", () => {
    expect(keyHintOf(API_KEY)).toBe("wxyz");
    expect(keyHintOf(API_KEY)).toHaveLength(4);
  });
});

describe("org.model_credential.set handler", () => {
  it("REFUSES to store a plaintext key when the KEK is unconfigured, and writes nothing", async () => {
    mocks.resolveKms.mockReturnValue(null);
    mocks.findFirst.mockResolvedValue(undefined);
    await expect(orgModelCredentialSetHandler(INPUT, CTX)).rejects.toThrow(
      /Refusing to store it in plaintext/,
    );
    expect(mocks.encrypt).not.toHaveBeenCalled();
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it("does NOT audit a refusal — a model_credential.set row means a key was stored", async () => {
    mocks.resolveKms.mockReturnValue(null);
    await expect(orgModelCredentialSetHandler(INPUT, CTX)).rejects.toThrow();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("envelope-encrypts the key before any database call", async () => {
    const order: string[] = [];
    mocks.encrypt.mockImplementation(() => {
      order.push("encrypt");
    });
    mocks.findFirst.mockImplementation(async () => {
      order.push("findFirst");
      return undefined;
    });
    await orgModelCredentialSetHandler(INPUT, CTX);
    expect(mocks.encrypt).toHaveBeenCalledWith(API_KEY, "model_credential_v1");
    expect(order).toEqual(["encrypt", "findFirst"]);
  });

  it("stores the ciphertext, the sha-256 digest and the last-four hint — never the key", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await orgModelCredentialSetHandler(INPUT, CTX);
    const written = mocks.insert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.keyCiphertext).toBeInstanceOf(Buffer);
    expect(written.keyKeyId).toBe("model_credential_v1");
    expect(written.keyDigest).toBe(
      createHash("sha256").update(API_KEY).digest("hex"),
    );
    expect(written.keyHint).toBe("wxyz");
    expect(written.provider).toBe("openrouter");
    expect(written.orgId).toBe(CTX.orgId);
    expect(written.createdById).toBe(CTX.userId);
    // No plaintext key anywhere in the persisted row.
    expect(JSON.stringify(written)).not.toContain(API_KEY);
    expect(JSON.stringify(written)).not.toContain("super-secret");
  });

  it("marks a new key active and unverified, and stamps rotatedAt", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await orgModelCredentialSetHandler(INPUT, CTX);
    const written = mocks.insert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.status).toBe("active");
    expect(written.lastVerifiedAt).toBeNull();
    expect(written.rotatedAt).toBeInstanceOf(Date);
    expect(written.updatedById).toBe(CTX.userId);
  });

  it("rotates in place: updates the live row instead of inserting a second one", async () => {
    mocks.findFirst.mockResolvedValue({ id: "row-1", provider: "gateway" });
    await orgModelCredentialSetHandler(INPUT, CTX);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.insert).not.toHaveBeenCalled();
    const written = mocks.update.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.provider).toBe("openrouter");
    expect(written.lastVerifiedAt).toBeNull();
    expect(written.rotatedAt).toBeInstanceOf(Date);
  });

  it("invalidates the resolver cache for exactly this org", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await orgModelCredentialSetHandler(INPUT, CTX);
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.invalidate).toHaveBeenCalledWith(CTX.orgId);
  });

  it("emits a model_credential.set security event with no key in it", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await orgModelCredentialSetHandler(INPUT, CTX);
    expect(mocks.emit).toHaveBeenCalledTimes(1);
    const event = mocks.emit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event.eventType).toBe("model_credential.set");
    expect(event.capability).toBe("set_model_credential");
    expect(event.outcome).toBe("success");
    expect(event.orgId).toBe(CTX.orgId);
    expect(event.actorUserId).toBe(CTX.userId);
    expect(event.workspaceId).toBeNull();
    expect(event.requestId).toBe(CTX.requestId);
    expect(JSON.stringify(event)).not.toContain(API_KEY);
    expect(JSON.stringify(event)).not.toContain(keyDigest(API_KEY));
  });

  it("returns the REDACTED view the contract declares, without the key or digest", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    const out = await orgModelCredentialSetHandler(INPUT, CTX);
    expect(() => orgModelCredentialSet.output.parse(out)).not.toThrow();
    expect(out).toMatchObject({
      configured: true,
      provider: "openrouter",
      status: "active",
      keyHint: "wxyz",
      lastVerifiedAt: null,
    });
    expect(typeof out.rotatedAt).toBe("string");
    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain(API_KEY);
    expect(serialised).not.toContain("super-secret");
    expect(serialised).not.toContain(keyDigest(API_KEY));
    expect(out).not.toHaveProperty("apiKey");
    expect(out).not.toHaveProperty("keyCiphertext");
    expect(out).not.toHaveProperty("keyDigest");
  });

  it("fails loudly, without auditing, when the write returned no row", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    const emptyTx = {
      ...makeTx(),
      insert: () => ({
        values: () => ({ returning: async () => [] }),
      }),
    };
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(emptyTx),
    );
    await expect(orgModelCredentialSetHandler(INPUT, CTX)).rejects.toThrow(
      /was not persisted/,
    );
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
});

describe("org.model_credential.set handler — the role gate", () => {
  it("refuses a non-admin BEFORE anything is encrypted or stored", async () => {
    // The attack this closes: a member stores an openai_compatible endpoint
    // they own, and every assistant conversation in the org goes to it.
    roleGate.refuse = true;
    try {
      await expect(
        orgModelCredentialSetHandler(
          {
            provider: "openai_compatible",
            apiKey: "sk-attacker-0123456789",
            baseUrl: "https://attacker.example.com/v1",
            modelMap: { balanced: "m" },
          },
          CTX,
        ),
      ).rejects.toThrow(/forbidden/);
    } finally {
      roleGate.refuse = false;
    }
  });

  it("asks for org Owner or Admin", async () => {
    roleGate.assertOrgRole.mockClear();
    roleGate.refuse = true;
    await orgModelCredentialSetHandler(
      { provider: "openrouter", apiKey: "sk-or-v1-0123456789" },
      CTX,
    ).catch(() => undefined);
    roleGate.refuse = false;
    expect(roleGate.assertOrgRole).toHaveBeenCalledWith(expect.anything(), {
      org: ["Owner", "Admin"],
    });
  });
});
