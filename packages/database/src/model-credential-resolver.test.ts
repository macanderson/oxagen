// model-credential-resolver.test.ts — the ADR-053 §2 envelope, opened once.
//
// Invariants:
//   1. No row, a disabled row, or a soft-deleted row → null, which routes the
//      turn to the platform key. The null answer is cached too, so a
//      platform-funded organisation does not pay a Postgres read per turn.
//   2. An active row round-trips through the real @oxagen/crypto envelope —
//      the resolver decrypts what the settings handler encrypted, and the
//      ciphertext never resembles the plaintext.
//   3. A stored row the resolver cannot open (KEK unset, or an envelope under
//      a different master key) resolves to null and LOGS why, and the log line
//      never carries the key or the ciphertext.
//   4. The read is cached for MODEL_CREDENTIAL_CACHE_TTL_MS, dropped by
//      invalidation per organisation, and a failed read is never cached.
//   5. The read goes through withTenantDb (RLS stays load-bearing) and filters
//      out soft-deleted rows itself.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { encrypt } from "@oxagen/crypto";
import { createLocalKmsAdapter } from "@oxagen/crypto/kms";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  withTenantDb: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("./tenant", () => ({
  withTenantDb: (fn: (tx: unknown) => Promise<unknown>) =>
    mocks.withTenantDb(fn),
}));
vi.mock("./logger", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: mocks.warn,
    error: mocks.error,
  },
}));

import {
  MODEL_CREDENTIAL_CACHE_TTL_MS,
  MODEL_CREDENTIAL_KEY_ID,
  invalidateModelCredentialCache,
  loadModelCredential,
  resetModelCredentialCacheForTests,
  resolveModelCredentialKms,
} from "./model-credential-resolver";

const ORG = "00000000-0000-0000-0000-00000000b222";
const OTHER_ORG = "00000000-0000-0000-0000-00000000b333";
// A deterministic 256-bit KEK. Test-only material; never a real key.
const MASTER_KEY_B64 = Buffer.alloc(32, 9).toString("base64");
const OTHER_MASTER_KEY_B64 = Buffer.alloc(32, 10).toString("base64");
const PLAINTEXT_KEY = "sk-or-v1-customer-secret-key";

async function envelopeFor(
  plaintext: string,
  masterKeyB64 = MASTER_KEY_B64,
): Promise<Buffer> {
  const adapter = createLocalKmsAdapter(Buffer.from(masterKeyB64, "base64"));
  return encrypt(plaintext, MODEL_CREDENTIAL_KEY_ID, { adapter });
}

async function activeRow(overrides: Record<string, unknown> = {}) {
  return {
    provider: "openrouter",
    status: "active",
    keyCiphertext: await envelopeFor(PLAINTEXT_KEY),
    keyKeyId: MODEL_CREDENTIAL_KEY_ID,
    keyDigest: "sha256:deadbeef",
    keyHint: "-key",
    ...overrides,
  };
}

beforeEach(() => {
  mocks.findFirst.mockReset();
  mocks.warn.mockReset();
  mocks.error.mockReset();
  mocks.withTenantDb.mockReset();
  mocks.withTenantDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ query: { modelCredentials: { findFirst: mocks.findFirst } } }),
  );
  resetModelCredentialCacheForTests();
  process.env.AUTH_TOKEN_ENCRYPTION_KEY = MASTER_KEY_B64;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
});

describe("resolveModelCredentialKms", () => {
  it("returns null when the KEK env var is unset", () => {
    delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
    expect(resolveModelCredentialKms()).toBeNull();
  });

  it("returns the versioned key id when configured", () => {
    expect(resolveModelCredentialKms()?.keyId).toBe(MODEL_CREDENTIAL_KEY_ID);
  });
});

describe("loadModelCredential — the null answers", () => {
  it("resolves null when the organisation has no row", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await expect(loadModelCredential(ORG)).resolves.toBeNull();
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("caches the null answer: a second call within the TTL does not hit Postgres", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await loadModelCredential(ORG);
    await loadModelCredential(ORG);
    expect(mocks.findFirst).toHaveBeenCalledTimes(1);
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
  });

  it("resolves null for a disabled row without touching the envelope", async () => {
    mocks.findFirst.mockResolvedValue(await activeRow({ status: "disabled" }));
    await expect(loadModelCredential(ORG)).resolves.toBeNull();
    // Nothing to explain: disabled is an operator's choice, not a failure.
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("resolves null and WARNS when a key is stored but the KEK is unset", async () => {
    delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
    mocks.findFirst.mockResolvedValue(await activeRow());
    await expect(loadModelCredential(ORG)).resolves.toBeNull();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    const [meta, msg] = mocks.warn.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(meta).toMatchObject({
      orgId: ORG,
      alert: "model_credential_kek_unset",
    });
    expect(msg).toMatch(/AUTH_TOKEN_ENCRYPTION_KEY is unset/);
    expect(JSON.stringify([meta, msg])).not.toContain(PLAINTEXT_KEY);
  });

  it("resolves null and logs an ERROR when the envelope was sealed under a different master key", async () => {
    mocks.findFirst.mockResolvedValue(
      await activeRow({
        keyCiphertext: await envelopeFor(PLAINTEXT_KEY, OTHER_MASTER_KEY_B64),
      }),
    );
    await expect(loadModelCredential(ORG)).resolves.toBeNull();
    expect(mocks.error).toHaveBeenCalledTimes(1);
    const [meta, msg] = mocks.error.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(meta).toMatchObject({
      orgId: ORG,
      keyKeyId: MODEL_CREDENTIAL_KEY_ID,
      alert: "model_credential_envelope_unreadable",
    });
    expect(typeof meta.err).toBe("string");
    expect(msg).toMatch(/could not be opened/);
    // Neither the ciphertext nor the plaintext reaches the log.
    expect(meta).not.toHaveProperty("keyCiphertext");
    expect(JSON.stringify([meta, msg])).not.toContain(PLAINTEXT_KEY);
  });

  it("resolves null and logs an ERROR for a ciphertext that is not an envelope at all", async () => {
    mocks.findFirst.mockResolvedValue(
      await activeRow({ keyCiphertext: Buffer.from([1, 2, 3]) }),
    );
    await expect(loadModelCredential(ORG)).resolves.toBeNull();
    expect(mocks.error).toHaveBeenCalledTimes(1);
  });
});

describe("loadModelCredential — an active row", () => {
  it("decrypts the stored key end to end and carries digest, hint and provider", async () => {
    const row = await activeRow();
    // The envelope must not contain the plaintext key anywhere.
    expect(row.keyCiphertext.toString("utf8")).not.toContain(PLAINTEXT_KEY);
    mocks.findFirst.mockResolvedValue(row);
    await expect(loadModelCredential(ORG)).resolves.toEqual({
      orgId: ORG,
      provider: "openrouter",
      apiKey: PLAINTEXT_KEY,
      digest: "sha256:deadbeef",
      keyHint: "-key",
    });
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("carries a gateway provider through", async () => {
    mocks.findFirst.mockResolvedValue(await activeRow({ provider: "gateway" }));
    await expect(loadModelCredential(ORG)).resolves.toMatchObject({
      provider: "gateway",
      apiKey: PLAINTEXT_KEY,
    });
  });

  it("reads through withTenantDb and filters soft-deleted rows itself", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await loadModelCredential(ORG);
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
    const query = mocks.findFirst.mock.calls[0]?.[0] as {
      where: Parameters<PgDialect["sqlToQuery"]>[0];
    };
    const rendered = new PgDialect().sqlToQuery(query.where);
    expect(rendered.sql).toMatch(/"org_id" = \$1/);
    expect(rendered.sql).toMatch(/"deleted_at" is null/);
    expect(rendered.params).toEqual([ORG]);
  });
});

describe("loadModelCredential — caching", () => {
  it("reads Postgres once per organisation within the TTL", async () => {
    mocks.findFirst.mockResolvedValue(await activeRow());
    const first = await loadModelCredential(ORG);
    const second = await loadModelCredential(ORG);
    expect(second).toBe(first);
    expect(mocks.findFirst).toHaveBeenCalledTimes(1);
  });

  it("re-reads once the TTL has elapsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T12:00:00Z"));
    mocks.findFirst.mockResolvedValue(undefined);
    await loadModelCredential(ORG);
    vi.setSystemTime(
      new Date("2026-09-09T12:00:00Z").getTime() +
        MODEL_CREDENTIAL_CACHE_TTL_MS -
        1,
    );
    await loadModelCredential(ORG);
    expect(mocks.findFirst).toHaveBeenCalledTimes(1);
    vi.setSystemTime(
      new Date("2026-09-09T12:00:00Z").getTime() +
        MODEL_CREDENTIAL_CACHE_TTL_MS,
    );
    await loadModelCredential(ORG);
    expect(mocks.findFirst).toHaveBeenCalledTimes(2);
  });

  it("invalidation forces a re-read for that organisation only", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await loadModelCredential(ORG);
    await loadModelCredential(OTHER_ORG);
    invalidateModelCredentialCache(ORG);
    await loadModelCredential(ORG); // re-read
    await loadModelCredential(OTHER_ORG); // still cached
    expect(mocks.findFirst).toHaveBeenCalledTimes(3);
  });

  it("a write that invalidates makes the new key visible on the next read", async () => {
    mocks.findFirst.mockResolvedValueOnce(undefined);
    await expect(loadModelCredential(ORG)).resolves.toBeNull();
    mocks.findFirst.mockResolvedValueOnce(await activeRow());
    invalidateModelCredentialCache(ORG);
    await expect(loadModelCredential(ORG)).resolves.toMatchObject({
      apiKey: PLAINTEXT_KEY,
    });
  });

  it("does not cache a failed read", async () => {
    mocks.findFirst.mockRejectedValueOnce(new Error("pg down"));
    await expect(loadModelCredential(ORG)).rejects.toThrow("pg down");
    mocks.findFirst.mockResolvedValue(await activeRow());
    await expect(loadModelCredential(ORG)).resolves.toMatchObject({
      apiKey: PLAINTEXT_KEY,
    });
    expect(mocks.findFirst).toHaveBeenCalledTimes(2);
  });

  it("the test seam drops every organisation's cached answer", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await loadModelCredential(ORG);
    await loadModelCredential(OTHER_ORG);
    resetModelCredentialCacheForTests();
    await loadModelCredential(ORG);
    await loadModelCredential(OTHER_ORG);
    expect(mocks.findFirst).toHaveBeenCalledTimes(4);
  });
});
