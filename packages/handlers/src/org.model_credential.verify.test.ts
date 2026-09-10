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
  return {
    ...real,
    withTenantDb: mocks.withTenantDb,
  };
});
vi.mock("@oxagen/database/model-credential", () => ({
  loadModelCredential: mocks.loadModelCredential,
}));

import { orgModelCredentialVerifyHandler } from "./org.model_credential.verify";
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
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.withTenantDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx()),
  );
  mocks.probe.mockResolvedValue({ ok: true, latencyMs: 42, error: null });
});

describe("org.model_credential.verify handler — a candidate key", () => {
  const input = { provider: "openrouter" as const, apiKey: CANDIDATE_KEY };

  it("probes the candidate against its vendor and reports the answer", async () => {
    const out = await orgModelCredentialVerifyHandler(input, CTX);
    expect(mocks.probe).toHaveBeenCalledWith({
      provider: "openrouter",
      apiKey: CANDIDATE_KEY,
    });
    expect(out).toEqual({
      ok: true,
      provider: "openrouter",
      latencyMs: 42,
      error: null,
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
    });
    const out = await orgModelCredentialVerifyHandler(input, CTX);
    expect(out).toEqual({
      ok: false,
      provider: "openrouter",
      latencyMs: 17,
      error: "Invalid API key",
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
    });
    expect(out).toEqual({
      ok: true,
      provider: "gateway",
      latencyMs: 42,
      error: null,
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
    expect(written).not.toHaveProperty("updatedByUserId");
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
