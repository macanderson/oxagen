/**
 * funding-source.test.ts — the seam that answers "whose key pays, and which
 * key spends?" (ADR-053 §2, ADR-131).
 *
 * Mocks the two resolvers that open KMS envelopes; this file is about the
 * mapping from a stored row to the `ModelFundingSource` every call path
 * threads through, not about decryption (see
 * packages/database/src/model-credential-resolver.test.ts and
 * assistant-model-key.test.ts for those).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadModelCredential: vi.fn(),
  loadAssistantModelKey: vi.fn(),
}));

vi.mock("@oxagen/database/model-credential", () => ({
  loadModelCredential: mocks.loadModelCredential,
}));

vi.mock("@oxagen/database/assistant-model-key", () => ({
  loadAssistantModelKey: mocks.loadAssistantModelKey,
}));

import { PLATFORM_FUNDING, resolveModelFundingSource } from "./funding-source";

const ORG = "00000000-0000-4000-8000-0000000000aa";

/** A key the customer brought. */
const BROUGHT = {
  orgId: ORG,
  provider: "openrouter" as const,
  apiKey: "sk-or-v1-customer-secret",
  digest: "sha256:abc",
  keyHint: "cret",
  baseUrl: null,
  modelMap: {},
};

/** A key Oxagen minted for the organisation on its own account. */
const MINTED = {
  orgId: ORG,
  provider: "openrouter" as const,
  apiKey: "sk-or-v1-oxagen-minted",
  digest: "sha256:def",
  keyHint: "nted",
  keyHash: "hash-1",
  keyName: "oxagen/acme/dana@acme.example",
  dailyLimitUsd: 25,
};

beforeEach(() => {
  mocks.loadModelCredential.mockReset();
  mocks.loadModelCredential.mockResolvedValue(null);
  mocks.loadAssistantModelKey.mockReset();
  mocks.loadAssistantModelKey.mockResolvedValue(null);
});

describe("resolveModelFundingSource", () => {
  it("answers the shared platform key when the organisation has no key of any kind", async () => {
    const source = await resolveModelFundingSource(ORG);
    // The shared constant, not a fresh object: callers may compare by identity.
    expect(source).toBe(PLATFORM_FUNDING);
    expect(source.fundedBy).toBe("platform");
    expect(source.modelKey).toBeUndefined();
    expect(mocks.loadModelCredential).toHaveBeenCalledWith(ORG);
  });

  it("answers the organisation's own key when a live credential is stored", async () => {
    mocks.loadModelCredential.mockResolvedValue(BROUGHT);
    await expect(resolveModelFundingSource(ORG)).resolves.toEqual({
      fundedBy: "org",
      modelKey: {
        provider: "openrouter",
        apiKey: "sk-or-v1-customer-secret",
        digest: "sha256:abc",
        baseUrl: null,
        modelMap: {},
      },
      keyHint: "cret",
    });
  });

  it("hands the provider factory only what it needs — no orgId or hint inside the key", async () => {
    mocks.loadModelCredential.mockResolvedValue(BROUGHT);
    const source = await resolveModelFundingSource(ORG);
    if (source.fundedBy !== "org") throw new Error("expected org funding");
    // The endpoint and the per-tier models travel with the key: the factory
    // needs them to build the provider. The orgId and the hint do not.
    expect(Object.keys(source.modelKey).sort()).toEqual([
      "apiKey",
      "baseUrl",
      "digest",
      "modelMap",
      "provider",
    ]);
  });

  it("carries a gateway credential through unchanged", async () => {
    mocks.loadModelCredential.mockResolvedValue({
      ...BROUGHT,
      provider: "gateway",
      apiKey: "vck_customer",
      digest: "sha256:def",
      keyHint: "omer",
    });
    const source = await resolveModelFundingSource(ORG);
    expect(source).toMatchObject({
      fundedBy: "org",
      modelKey: { provider: "gateway", apiKey: "vck_customer" },
      keyHint: "omer",
    });
  });

  // ── ADR-131: the minted key ────────────────────────────────────────────────

  it("spends the minted key but still bills the organisation for the tokens", async () => {
    mocks.loadAssistantModelKey.mockResolvedValue(MINTED);
    const source = await resolveModelFundingSource(ORG);
    // The whole point: a key of its own AND a platform-funded turn. Reading
    // `fundedBy` to decide whether a key exists is the bug this pair exists to
    // make impossible.
    expect(source.fundedBy).toBe("platform");
    expect(source.modelKey).toEqual({
      provider: "openrouter",
      apiKey: "sk-or-v1-oxagen-minted",
      digest: "sha256:def",
      baseUrl: null,
      modelMap: null,
    });
    expect(source.keyHint).toBe("nted");
  });

  it("prefers the key the customer brought over the one Oxagen minted", async () => {
    // An organisation that adopts BYOK stops being billed from that moment,
    // and a minted key left behind must not keep spending Oxagen's money
    // underneath it.
    mocks.loadModelCredential.mockResolvedValue(BROUGHT);
    mocks.loadAssistantModelKey.mockResolvedValue(MINTED);
    const source = await resolveModelFundingSource(ORG);
    expect(source.fundedBy).toBe("org");
    expect(source.modelKey?.apiKey).toBe("sk-or-v1-customer-secret");
    // Not even asked for: the brought key short-circuits the lookup.
    expect(mocks.loadAssistantModelKey).not.toHaveBeenCalled();
  });

  it("propagates a failed read rather than silently billing the platform key", async () => {
    // A DB outage must not turn an organisation on its own key into a
    // platform-funded (and billed) one. The resolver swallows only an
    // unreadable envelope; a read that failed is the caller's to see.
    mocks.loadModelCredential.mockRejectedValue(new Error("pg down"));
    await expect(resolveModelFundingSource(ORG)).rejects.toThrow("pg down");
  });
});
