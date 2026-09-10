/**
 * funding-source.test.ts — the one seam that answers "whose key pays?" (ADR-053 §2).
 *
 * Mocks `@oxagen/database/model-credential`, the resolver that opens the KMS
 * envelope; this file is about the mapping from a stored credential to the
 * `ModelFundingSource` every call path threads through, not about decryption
 * (see packages/database/src/model-credential-resolver.test.ts for that).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ loadModelCredential: vi.fn() }));

vi.mock("@oxagen/database/model-credential", () => ({
  loadModelCredential: mocks.loadModelCredential,
}));

import { PLATFORM_FUNDING, resolveModelFundingSource } from "./funding-source";

const ORG = "00000000-0000-4000-8000-0000000000aa";

const STORED = {
  orgId: ORG,
  provider: "openrouter" as const,
  apiKey: "sk-or-v1-customer-secret",
  digest: "sha256:abc",
  keyHint: "cret",
};

beforeEach(() => {
  mocks.loadModelCredential.mockReset();
});

describe("resolveModelFundingSource", () => {
  it("answers the platform key when the organisation has stored no credential", async () => {
    mocks.loadModelCredential.mockResolvedValue(null);
    const source = await resolveModelFundingSource(ORG);
    // The shared constant, not a fresh object: callers may compare by identity.
    expect(source).toBe(PLATFORM_FUNDING);
    expect(source.fundedBy).toBe("platform");
    expect(source.credential).toBeUndefined();
    expect(mocks.loadModelCredential).toHaveBeenCalledWith(ORG);
  });

  it("answers the organisation's own key when a live credential is stored", async () => {
    mocks.loadModelCredential.mockResolvedValue(STORED);
    await expect(resolveModelFundingSource(ORG)).resolves.toEqual({
      fundedBy: "org",
      credential: {
        provider: "openrouter",
        apiKey: "sk-or-v1-customer-secret",
        digest: "sha256:abc",
      },
      keyHint: "cret",
    });
  });

  it("hands the provider factory only what it needs — no orgId or hint inside the credential", async () => {
    mocks.loadModelCredential.mockResolvedValue(STORED);
    const source = await resolveModelFundingSource(ORG);
    if (source.fundedBy !== "org") throw new Error("expected org funding");
    expect(Object.keys(source.credential).sort()).toEqual([
      "apiKey",
      "digest",
      "provider",
    ]);
  });

  it("carries a gateway credential through unchanged", async () => {
    mocks.loadModelCredential.mockResolvedValue({
      ...STORED,
      provider: "gateway",
      apiKey: "vck_customer",
      digest: "sha256:def",
      keyHint: "omer",
    });
    const source = await resolveModelFundingSource(ORG);
    expect(source).toMatchObject({
      fundedBy: "org",
      credential: { provider: "gateway", apiKey: "vck_customer" },
      keyHint: "omer",
    });
  });

  it("propagates a failed read rather than silently billing the platform key", async () => {
    // A DB outage must not turn an organisation on its own key into a
    // platform-funded (and billed) one. The resolver swallows only an
    // unreadable envelope; a read that failed is the caller's to see.
    mocks.loadModelCredential.mockRejectedValue(new Error("pg down"));
    await expect(resolveModelFundingSource(ORG)).rejects.toThrow("pg down");
  });
});
