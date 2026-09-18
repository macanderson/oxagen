import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  probe: vi.fn(),
  loadModelCredential: vi.fn(),
  update: vi.fn(),
  withTenantDb: vi.fn(),
}));

/** Minimal Drizzle chain double: .update().set().where() records the values. */
function makeTx() {
  return {
    update: () => ({
      set: (values: unknown) => ({
        where: async () => {
          mocks.update(values);
        },
      }),
    }),
  };
}

vi.mock("@oxagen/ai", () => ({
  probeModelCredential: mocks.probe,
}));
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
  loadModelCredential: mocks.loadModelCredential,
}));

import { orgModelCredentialVerifyHandler } from "./org.model_credential.verify";
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

import { orgModelCredentialVerify } from "@oxagen/oxagen/contracts/org.model_credential.verify";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

const CANDIDATE_KEY = "sk-or-v1-candidate-0123456789abcd";
const STORED_KEY = "vck_stored-secret-0123456789wxyz";

const STORED = {
  orgId: CTX.orgId,
  provider: "gateway" as const,
  apiKey: STORED_KEY,
  digest: "digest-of-the-stored-key",
  keyHint: "wxyz",
  // The resolver always returns both: null and {} for a routed provider.
  baseUrl: null,
  modelMap: {},
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.withTenantDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx()),
  );
  mocks.probe.mockResolvedValue({
    ok: true,
    latencyMs: 42,
    error: null,
    toolCalling: true,
  });
});

describe("org.model_credential.verify handler — a candidate key", () => {
  const input = { provider: "openrouter" as const, apiKey: CANDIDATE_KEY };

  it("probes the candidate against its vendor and reports the answer", async () => {
    const out = await orgModelCredentialVerifyHandler(input, CTX);
    expect(mocks.probe).toHaveBeenCalledWith({
      provider: "openrouter",
      apiKey: CANDIDATE_KEY,
      baseUrl: null,
      toolProbeModel: null,
    });
    expect(out).toEqual({
      ok: true,
      provider: "openrouter",
      latencyMs: 42,
      error: null,
      toolCalling: true,
    });
    expect(() => orgModelCredentialVerify.output.parse(out)).not.toThrow();
  });

  it("reads and writes nothing — the stored key is not consulted", async () => {
    await orgModelCredentialVerifyHandler(input, CTX);
    expect(mocks.loadModelCredential).not.toHaveBeenCalled();
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("reports a refusal with the vendor's message rather than throwing", async () => {
    mocks.probe.mockResolvedValue({
      ok: false,
      latencyMs: 17,
      error: "Invalid API key",
      toolCalling: null,
    });
    const out = await orgModelCredentialVerifyHandler(input, CTX);
    expect(out).toEqual({
      ok: false,
      provider: "openrouter",
      latencyMs: 17,
      error: "Invalid API key",
      toolCalling: null,
    });
  });

  it("never echoes the candidate key in the result", async () => {
    const out = await orgModelCredentialVerifyHandler(input, CTX);
    expect(JSON.stringify(out)).not.toContain(CANDIDATE_KEY);
  });

  it("refuses a half pair rather than quietly verifying the stored key", async () => {
    await expect(
      orgModelCredentialVerifyHandler({ provider: "openrouter" }, CTX),
    ).rejects.toThrow(/must be given together/);
    await expect(
      orgModelCredentialVerifyHandler({ apiKey: CANDIDATE_KEY }, CTX),
    ).rejects.toThrow(/must be given together/);
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.loadModelCredential).not.toHaveBeenCalled();
  });
});

describe("org.model_credential.verify handler — the stored key", () => {
  it("opens the stored credential through the resolver and probes it", async () => {
    mocks.loadModelCredential.mockResolvedValue(STORED);
    const out = await orgModelCredentialVerifyHandler({}, CTX);
    expect(mocks.loadModelCredential).toHaveBeenCalledWith(CTX.orgId);
    expect(mocks.probe).toHaveBeenCalledWith({
      provider: "gateway",
      apiKey: STORED_KEY,
      baseUrl: null,
      toolProbeModel: null,
    });
    expect(out).toEqual({
      ok: true,
      provider: "gateway",
      latencyMs: 42,
      error: null,
      toolCalling: true,
    });
    expect(() => orgModelCredentialVerify.output.parse(out)).not.toThrow();
  });

  it("stamps lastVerifiedAt on the live row when the vendor said yes", async () => {
    mocks.loadModelCredential.mockResolvedValue(STORED);
    await orgModelCredentialVerifyHandler({}, CTX);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    const written = mocks.update.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.lastVerifiedAt).toBeInstanceOf(Date);
    // A health fact, not an edit: the audit columns are left alone.
    expect(written).not.toHaveProperty("updatedAt");
    expect(written).not.toHaveProperty("updatedById");
  });

  it("stamps NOTHING when the vendor refused — the column records the last yes", async () => {
    mocks.loadModelCredential.mockResolvedValue(STORED);
    mocks.probe.mockResolvedValue({
      ok: false,
      latencyMs: 9,
      error: "HTTP 401",
    });
    const out = await orgModelCredentialVerifyHandler({}, CTX);
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(out).toEqual({
      ok: false,
      provider: "gateway",
      latencyMs: 9,
      error: "HTTP 401",
    });
  });

  it("throws a named error when no credential is stored", async () => {
    mocks.loadModelCredential.mockResolvedValue(null);
    await expect(orgModelCredentialVerifyHandler({}, CTX)).rejects.toThrow(
      "No model credential is stored for this organisation",
    );
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("never echoes the stored key or its digest in the result", async () => {
    mocks.loadModelCredential.mockResolvedValue(STORED);
    const out = await orgModelCredentialVerifyHandler({}, CTX);
    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain(STORED_KEY);
    expect(serialised).not.toContain(STORED.digest);
  });
});

describe("org.model_credential.verify handler — an openai_compatible key", () => {
  const COMPAT_STORED = {
    ...STORED,
    provider: "openai_compatible" as const,
    baseUrl: "https://api.together.xyz/v1",
    modelMap: { balanced: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  };

  it("asks the tool question of the model the assistant will actually run on", async () => {
    mocks.loadModelCredential.mockResolvedValue(COMPAT_STORED);
    await orgModelCredentialVerifyHandler({}, CTX);
    expect(mocks.probe).toHaveBeenCalledWith({
      provider: "openai_compatible",
      apiKey: STORED_KEY,
      baseUrl: "https://api.together.xyz/v1",
      toolProbeModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    });
  });

  it("does NOT stamp lastVerifiedAt when the key works but the endpoint cannot call tools", async () => {
    // The key is accepted, so a naive check would call this healthy. It is
    // not: every assistant turn needs tool calls, so this endpoint answers
    // nothing about the workspace. `last_verified_at` is what the settings
    // page shows as working, and it must not say so here.
    mocks.loadModelCredential.mockResolvedValue(COMPAT_STORED);
    mocks.probe.mockResolvedValue({
      ok: true,
      latencyMs: 30,
      error: "tools are not supported for this model",
      toolCalling: false,
    });
    const out = await orgModelCredentialVerifyHandler({}, CTX);
    expect(out.ok).toBe(true);
    expect(out.toolCalling).toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("stamps lastVerifiedAt when the key works AND the endpoint calls tools", async () => {
    mocks.loadModelCredential.mockResolvedValue(COMPAT_STORED);
    await orgModelCredentialVerifyHandler({}, CTX);
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });
});

describe("org.model_credential.verify handler — the role gate", () => {
  it("refuses a non-admin before the stored key is opened", async () => {
    roleGate.refuse = true;
    try {
      await expect(orgModelCredentialVerifyHandler({}, CTX)).rejects.toThrow(
        /forbidden/,
      );
      expect(mocks.loadModelCredential).not.toHaveBeenCalled();
      expect(mocks.probe).not.toHaveBeenCalled();
    } finally {
      roleGate.refuse = false;
    }
  });

  it("reports a missing stored key as not_found, not an unclassified error", async () => {
    mocks.loadModelCredential.mockResolvedValue(null);
    await expect(
      orgModelCredentialVerifyHandler({}, CTX),
    ).rejects.toMatchObject({
      code: "not_found",
      reason: "model_credential_not_stored",
    });
  });
});
