// assistant-model-key.test.ts — the ADR-131 envelope, opened and written.
//
// Its neighbour `model-credential-resolver.test.ts` covers the key a CUSTOMER
// brought. This covers the key OXAGEN minted for one organisation, which
// looks identical and means the opposite thing about money. The invariants
// that matter here and are not shared:
//
//   1. Every failure resolves to null and logs why. The organisation falls
//      back to the shared key, which costs attribution and not money —
//      Oxagen pays for the tokens either way. Throwing would stop an
//      assistant answering over a key-management problem the customer cannot
//      see and did not cause.
//   2. The write goes through withSystemDb, because the organisation was
//      created moments ago and no tenant scope for it is open; the read goes
//      through withTenantDb, so RLS stays load-bearing.
//   3. Both write failure modes THROW. Each one leaves a spendable key at the
//      vendor that nothing references, and the caller's catch is what deletes
//      it. Returning a flag is how a key is stranded.
//   4. `dailyLimitUsd` crosses node-postgres as a string and comes back a
//      number, because the one consumer compares it to what the vendor says.
//   5. No log line and no error ever carries the key or the ciphertext.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encrypt } from "@oxagen/crypto";
import { createLocalKmsAdapter } from "@oxagen/crypto/kms";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  systemFindFirst: vi.fn(),
  insertValues: vi.fn(),
  updateSet: vi.fn(),
  select: vi.fn(),
  withTenantDb: vi.fn(),
  withSystemDb: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("./tenant", () => ({
  withTenantDb: (fn: (tx: unknown) => Promise<unknown>) =>
    mocks.withTenantDb(fn),
  withSystemDb: (fn: (tx: unknown) => Promise<unknown>) =>
    mocks.withSystemDb(fn),
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
  ASSISTANT_MODEL_KEY_CACHE_TTL_MS,
  ASSISTANT_MODEL_KEY_KEY_ID,
  AssistantModelKeyExistsError,
  AssistantModelKeyKekUnsetError,
  assistantKeyDigest,
  assistantKeyHint,
  hasAssistantModelKey,
  invalidateAssistantModelKeyCache,
  listAssistantModelKeyHandles,
  loadAssistantModelKey,
  logAssistantModelKeyFailure,
  markAssistantModelKeyDisabled,
  recordAssistantModelKey,
  resetAssistantModelKeyCacheForTests,
  resolveAssistantModelKeyKms,
} from "./assistant-model-key";

const ORG = "00000000-0000-0000-0000-00000000c111";
// A deterministic 256-bit KEK. Test-only material; never a real key.
const MASTER_KEY_B64 = Buffer.alloc(32, 7).toString("base64");
const OTHER_MASTER_KEY_B64 = Buffer.alloc(32, 8).toString("base64");
const PLAINTEXT_KEY = "sk-or-v1-oxagen-minted-for-acme";

async function envelopeFor(
  plaintext: string,
  masterKeyB64 = MASTER_KEY_B64,
): Promise<Buffer> {
  const adapter = createLocalKmsAdapter(Buffer.from(masterKeyB64, "base64"));
  return encrypt(plaintext, ASSISTANT_MODEL_KEY_KEY_ID, { adapter });
}

async function activeRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "active",
    keyCiphertext: await envelopeFor(PLAINTEXT_KEY),
    keyKeyId: ASSISTANT_MODEL_KEY_KEY_ID,
    keyDigest: assistantKeyDigest(PLAINTEXT_KEY),
    keyHint: "acme",
    keyHash: "hash-abc",
    keyName: "oxagen/acme-corp/dana@acme.example",
    // node-postgres hands back numeric(10,2) as a string. The fixture is a
    // string on purpose: a number here would hide the parse this file exists
    // partly to hold.
    dailyLimitUsd: "25.00",
    ...overrides,
  };
}

/** A drizzle-ish insert chain that records what it was handed. */
function insertTx() {
  return {
    insert: () => ({
      values: (v: unknown) => mocks.insertValues(v),
    }),
    update: () => ({
      set: (v: unknown) => ({ where: () => mocks.updateSet(v) }),
    }),
    select: (cols: unknown) => ({ from: () => mocks.select(cols) }),
    query: { assistantModelKeys: { findFirst: mocks.systemFindFirst } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withTenantDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ query: { assistantModelKeys: { findFirst: mocks.findFirst } } }),
  );
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(insertTx()),
  );
  mocks.insertValues.mockResolvedValue(undefined);
  mocks.updateSet.mockResolvedValue(undefined);
  mocks.select.mockResolvedValue([]);
  resetAssistantModelKeyCacheForTests();
  process.env.AUTH_TOKEN_ENCRYPTION_KEY = MASTER_KEY_B64;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
});

describe("the small pure pieces", () => {
  it("digests the key rather than storing it, and hints only at its tail", () => {
    expect(assistantKeyDigest(PLAINTEXT_KEY)).toMatch(/^[0-9a-f]{64}$/);
    expect(assistantKeyDigest(PLAINTEXT_KEY)).not.toContain("sk-or");
    expect(assistantKeyHint(PLAINTEXT_KEY)).toBe("acme");
    expect(assistantKeyHint(PLAINTEXT_KEY)).toHaveLength(4);
  });

  it("carries its own key-version label, so the two tables can be re-keyed apart", () => {
    expect(ASSISTANT_MODEL_KEY_KEY_ID).toBe("assistant_model_key_v1");
    expect(resolveAssistantModelKeyKms()?.keyId).toBe(
      ASSISTANT_MODEL_KEY_KEY_ID,
    );
  });

  it("has no KMS adapter when the KEK is unset", () => {
    delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
    expect(resolveAssistantModelKeyKms()).toBeNull();
  });
});

describe("loadAssistantModelKey — the live key", () => {
  it("opens the envelope and hands back the key with its vendor handle", async () => {
    mocks.findFirst.mockResolvedValue(await activeRow());
    await expect(loadAssistantModelKey(ORG)).resolves.toEqual({
      orgId: ORG,
      provider: "openrouter",
      apiKey: PLAINTEXT_KEY,
      digest: assistantKeyDigest(PLAINTEXT_KEY),
      keyHint: "acme",
      keyHash: "hash-abc",
      keyName: "oxagen/acme-corp/dana@acme.example",
      dailyLimitUsd: 25,
    });
  });

  it("parses the ceiling into a number, because the vendor reports one", async () => {
    // The column is numeric(10,2) and node-postgres serves it as a string.
    // `"25.00" > 20` is a string comparison that is false; the bug it would
    // cause is a reconciliation report that never flags an over-ceiling key.
    mocks.findFirst.mockResolvedValue(await activeRow());
    const key = await loadAssistantModelKey(ORG);
    expect(typeof key?.dailyLimitUsd).toBe("number");
    expect(key!.dailyLimitUsd).toBe(25);
  });

  it("reads through withTenantDb, so RLS stays load-bearing", async () => {
    mocks.findFirst.mockResolvedValue(await activeRow());
    await loadAssistantModelKey(ORG);
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });
});

describe("loadAssistantModelKey — every failure is null, and says why", () => {
  it("resolves null and stays quiet when the organisation has no key", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await expect(loadAssistantModelKey(ORG)).resolves.toBeNull();
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("caches the null answer, so an organisation on the shared key pays no read per turn", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await loadAssistantModelKey(ORG);
    await loadAssistantModelKey(ORG);
    expect(mocks.findFirst).toHaveBeenCalledTimes(1);
  });

  it("resolves null for a disabled row without touching the envelope", async () => {
    mocks.findFirst.mockResolvedValue(await activeRow({ status: "disabled" }));
    await expect(loadAssistantModelKey(ORG)).resolves.toBeNull();
    // Disabled is an operator's decision, not a failure. Nothing to explain.
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("resolves null and WARNS when a key is stored but the KEK is unset", async () => {
    delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
    mocks.findFirst.mockResolvedValue(await activeRow());
    await expect(loadAssistantModelKey(ORG)).resolves.toBeNull();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn.mock.calls[0]![0]).toMatchObject({
      orgId: ORG,
      alert: "assistant_model_key_kek_unset",
    });
  });

  it("resolves null and ERRORS on an envelope under a different master key", async () => {
    mocks.findFirst.mockResolvedValue(
      await activeRow({
        keyCiphertext: await envelopeFor(PLAINTEXT_KEY, OTHER_MASTER_KEY_B64),
      }),
    );
    await expect(loadAssistantModelKey(ORG)).resolves.toBeNull();
    expect(mocks.error).toHaveBeenCalledTimes(1);
    expect(mocks.error.mock.calls[0]![0]).toMatchObject({
      alert: "assistant_model_key_envelope_unreadable",
    });
  });

  it("never puts the key or the ciphertext in a log line", async () => {
    // Both failure logs, checked together: a line nobody thought was
    // sensitive is how a key survives in a log aggregator forever.
    delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
    mocks.findFirst.mockResolvedValue(await activeRow());
    await loadAssistantModelKey(ORG);

    process.env.AUTH_TOKEN_ENCRYPTION_KEY = MASTER_KEY_B64;
    resetAssistantModelKeyCacheForTests();
    mocks.findFirst.mockResolvedValue(
      await activeRow({
        keyCiphertext: await envelopeFor(PLAINTEXT_KEY, OTHER_MASTER_KEY_B64),
      }),
    );
    await loadAssistantModelKey(ORG);

    const logged = JSON.stringify([
      ...mocks.warn.mock.calls,
      ...mocks.error.mock.calls,
    ]);
    expect(logged).not.toContain(PLAINTEXT_KEY);
    expect(logged).not.toContain("sk-or-v1");
    expect(logged).not.toContain("ciphertext");
  });
});

describe("loadAssistantModelKey — the cache", () => {
  it("re-reads after the TTL, so a key switched off stops spending within seconds", async () => {
    vi.useFakeTimers();
    mocks.findFirst.mockResolvedValue(await activeRow());
    await loadAssistantModelKey(ORG);
    vi.advanceTimersByTime(ASSISTANT_MODEL_KEY_CACHE_TTL_MS + 1);
    await loadAssistantModelKey(ORG);
    expect(mocks.findFirst).toHaveBeenCalledTimes(2);
  });

  it("drops one organisation's answer on invalidation and leaves the rest", async () => {
    const OTHER = "00000000-0000-0000-0000-00000000c222";
    mocks.findFirst.mockResolvedValue(await activeRow());
    await loadAssistantModelKey(ORG);
    await loadAssistantModelKey(OTHER);
    invalidateAssistantModelKeyCache(ORG);
    await loadAssistantModelKey(ORG);
    await loadAssistantModelKey(OTHER);
    expect(mocks.findFirst).toHaveBeenCalledTimes(3);
  });
});

describe("recordAssistantModelKey", () => {
  it("envelopes the key and writes the hash, name, digest and hint beside it", async () => {
    await recordAssistantModelKey({
      orgId: ORG,
      apiKey: PLAINTEXT_KEY,
      keyHash: "hash-abc",
      keyName: "oxagen/acme-corp/dana@acme.example",
      dailyLimitUsd: 25,
      actorUserId: "user-1",
    });

    const row = mocks.insertValues.mock.calls[0]![0] as Record<string, unknown>;
    expect(row).toMatchObject({
      orgId: ORG,
      provider: "openrouter",
      keyHash: "hash-abc",
      keyName: "oxagen/acme-corp/dana@acme.example",
      keyKeyId: ASSISTANT_MODEL_KEY_KEY_ID,
      keyDigest: assistantKeyDigest(PLAINTEXT_KEY),
      keyHint: "acme",
      status: "active",
      createdById: "user-1",
      updatedById: "user-1",
    });
    // The plaintext is in the envelope and nowhere else in the row.
    expect(Buffer.isBuffer(row["keyCiphertext"])).toBe(true);
    expect((row["keyCiphertext"] as Buffer).toString("utf8")).not.toContain(
      PLAINTEXT_KEY,
    );
    const withoutEnvelope = { ...row, keyCiphertext: undefined };
    expect(JSON.stringify(withoutEnvelope)).not.toContain(PLAINTEXT_KEY);
  });

  it("writes the ceiling as a fixed-scale string, the way the numeric column reads it", async () => {
    await recordAssistantModelKey({
      orgId: ORG,
      apiKey: PLAINTEXT_KEY,
      keyHash: "h",
      keyName: "n",
      dailyLimitUsd: 25,
    });
    expect(mocks.insertValues.mock.calls[0]![0].dailyLimitUsd).toBe("25.00");
  });

  it("writes through withSystemDb, because the new organisation has no open scope", async () => {
    await recordAssistantModelKey({
      orgId: ORG,
      apiKey: PLAINTEXT_KEY,
      keyHash: "h",
      keyName: "n",
      dailyLimitUsd: 25,
    });
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("drops the cached answer, so the next turn sees the key it just stored", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await loadAssistantModelKey(ORG); // caches "no key"
    await recordAssistantModelKey({
      orgId: ORG,
      apiKey: PLAINTEXT_KEY,
      keyHash: "h",
      keyName: "n",
      dailyLimitUsd: 25,
    });
    mocks.findFirst.mockResolvedValue(await activeRow());
    await expect(loadAssistantModelKey(ORG)).resolves.toMatchObject({
      apiKey: PLAINTEXT_KEY,
    });
  });

  it("throws rather than storing nothing when the KEK is unset", async () => {
    // The caller's catch is what deletes the key it just minted. Returning
    // quietly here strands a spendable key at the vendor.
    delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
    await expect(
      recordAssistantModelKey({
        orgId: ORG,
        apiKey: PLAINTEXT_KEY,
        keyHash: "h",
        keyName: "n",
        dailyLimitUsd: 25,
      }),
    ).rejects.toBeInstanceOf(AssistantModelKeyKekUnsetError);
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("names the race when the organisation's unique index refuses the insert", async () => {
    mocks.insertValues.mockRejectedValue(
      Object.assign(new Error("duplicate key"), {
        cause: { code: "23505", constraint: "assistant_model_keys_org_unique" },
      }),
    );
    await expect(
      recordAssistantModelKey({
        orgId: ORG,
        apiKey: PLAINTEXT_KEY,
        keyHash: "h",
        keyName: "n",
        dailyLimitUsd: 25,
      }),
    ).rejects.toBeInstanceOf(AssistantModelKeyExistsError);
  });

  it("does not mistake a different constraint for the race", async () => {
    // A hash collision is a real fault and must not be answered by deleting
    // a key and calling it an ordinary outcome.
    mocks.insertValues.mockRejectedValue(
      Object.assign(new Error("duplicate key"), {
        cause: {
          code: "23505",
          constraint: "assistant_model_keys_hash_unique",
        },
      }),
    );
    const err = await recordAssistantModelKey({
      orgId: ORG,
      apiKey: PLAINTEXT_KEY,
      keyHash: "h",
      keyName: "n",
      dailyLimitUsd: 25,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AssistantModelKeyExistsError);
  });

  it("does not drop the cache when the write failed", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await loadAssistantModelKey(ORG);
    mocks.insertValues.mockRejectedValue(new Error("pg down"));
    await recordAssistantModelKey({
      orgId: ORG,
      apiKey: PLAINTEXT_KEY,
      keyHash: "h",
      keyName: "n",
      dailyLimitUsd: 25,
    }).catch(() => undefined);
    await loadAssistantModelKey(ORG);
    expect(mocks.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe("markAssistantModelKeyDisabled", () => {
  it("disables and timestamps, and never deletes", async () => {
    // A deleted key takes its usage history with it, and the invoice for the
    // month it was deleted in stops reconciling.
    await markAssistantModelKeyDisabled(ORG, "offboarded");
    const set = mocks.updateSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(set["status"]).toBe("disabled");
    expect(set["disabledAt"]).toBeInstanceOf(Date);
    expect(set["lastError"]).toBe("offboarded");
  });

  it("scrubs key material out of the reason before it is stored", async () => {
    // `last_error` promises a reason scrubbed by the writer. A caller
    // quoting the vendor's response can quote the key the request carried.
    await markAssistantModelKeyDisabled(
      ORG,
      "vendor refused sk-or-v1-abc123DEF456 with 401",
    );
    expect(mocks.updateSet.mock.calls[0]![0]["lastError"]).toBe(
      "vendor refused sk-or-v1-[redacted] with 401",
    );
  });

  it("bounds the reason, so a stack trace cannot fill the column", async () => {
    await markAssistantModelKeyDisabled(ORG, "x".repeat(2000));
    expect(String(mocks.updateSet.mock.calls[0]![0]["lastError"])).toHaveLength(
      500,
    );
  });

  it("omits the reason entirely when there is none", async () => {
    await markAssistantModelKeyDisabled(ORG);
    expect(mocks.updateSet.mock.calls[0]![0]).not.toHaveProperty("lastError");
  });

  it("drops the cached answer, so the key stops being used within one call", async () => {
    mocks.findFirst.mockResolvedValue(await activeRow());
    await loadAssistantModelKey(ORG);
    await markAssistantModelKeyDisabled(ORG);
    mocks.findFirst.mockResolvedValue(await activeRow({ status: "disabled" }));
    await expect(loadAssistantModelKey(ORG)).resolves.toBeNull();
  });
});

describe("listAssistantModelKeyHandles", () => {
  it("returns handles and ceilings, and no envelope to decrypt", async () => {
    mocks.select.mockResolvedValue([
      {
        orgId: ORG,
        keyHash: "hash-abc",
        keyName: "oxagen/acme-corp/dana@acme.example",
        status: "active",
        dailyLimitUsd: "25.00",
      },
    ]);
    const rows = await listAssistantModelKeyHandles();
    expect(rows).toEqual([
      {
        orgId: ORG,
        keyHash: "hash-abc",
        keyName: "oxagen/acme-corp/dana@acme.example",
        status: "active",
        dailyLimitUsd: 25,
      },
    ]);
    // The reconciliation report has no business holding a key.
    const selected = Object.keys(mocks.select.mock.calls[0]![0] as object);
    expect(selected).not.toContain("keyCiphertext");
    expect(selected).not.toContain("keyDigest");
  });
});

describe("hasAssistantModelKey", () => {
  it("answers on an id alone, so the common case is one indexed read", async () => {
    mocks.systemFindFirst.mockResolvedValue({ id: "row-1" });
    await expect(hasAssistantModelKey(ORG)).resolves.toBe(true);
    expect(mocks.systemFindFirst.mock.calls[0]![0].columns).toEqual({
      id: true,
    });
  });

  it("answers false for an organisation with no row", async () => {
    mocks.systemFindFirst.mockResolvedValue(undefined);
    await expect(hasAssistantModelKey(ORG)).resolves.toBe(false);
  });
});

describe("logAssistantModelKeyFailure", () => {
  it("reports a failure as a log line with an alert, never as a row", async () => {
    // A row in this table means "a key exists at the vendor", and the NOT
    // NULL envelope says so. A failure has no key to record.
    logAssistantModelKeyFailure(ORG, new Error("upstream 503"), "mint");
    expect(mocks.error).toHaveBeenCalledTimes(1);
    expect(mocks.error.mock.calls[0]![0]).toMatchObject({
      orgId: ORG,
      phase: "mint",
      alert: "assistant_model_key_provision_failed",
      err: "upstream 503",
    });
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("scrubs key material out of the logged failure", () => {
    logAssistantModelKeyFailure(
      ORG,
      new Error("PUT /keys sk-or-v1-abc123DEF456 refused"),
      "store",
    );
    expect(mocks.error.mock.calls[0]![0].err).toBe(
      "PUT /keys sk-or-v1-[redacted] refused",
    );
  });

  it("handles a thrown non-Error without throwing itself", () => {
    expect(() =>
      logAssistantModelKeyFailure(ORG, "a string", "store"),
    ).not.toThrow();
    expect(mocks.error.mock.calls[0]![0].err).toBe("a string");
  });
});
