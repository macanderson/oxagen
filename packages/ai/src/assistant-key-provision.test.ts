/**
 * Giving one organisation its own key, once (ADR-131).
 *
 * The vendor and the database are both faked. What is under test is the
 * ordering between them and what happens when either half fails — the part
 * that decides whether a bad minute leaves an orphan (a key nobody
 * references) or a phantom (a row referencing a key that does not exist).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAssistantKey: vi.fn(),
  deleteAssistantKey: vi.fn(),
  hasAssistantModelKey: vi.fn(),
  recordAssistantModelKey: vi.fn(),
  logAssistantModelKeyFailure: vi.fn(),
  /** Every vendor and database call, in the order they were made. */
  order: [] as string[],
  // Stand-ins for the real classes, so the module's `instanceof` branches
  // behave as they do in production. They live in the hoisted block because
  // a class declaration is not hoisted past `vi.mock`.
  AssistantModelKeyExistsError: class AssistantModelKeyExistsError extends Error {},
  AssistantModelKeyKekUnsetError: class AssistantModelKeyKekUnsetError extends Error {},
}));

vi.mock("./openrouter-provisioning", async () => {
  const actual = await vi.importActual<
    typeof import("./openrouter-provisioning")
  >("./openrouter-provisioning");
  return {
    ...actual,
    createAssistantKey: mocks.createAssistantKey,
    deleteAssistantKey: mocks.deleteAssistantKey,
  };
});

vi.mock("@oxagen/database/assistant-model-key", () => ({
  hasAssistantModelKey: mocks.hasAssistantModelKey,
  recordAssistantModelKey: mocks.recordAssistantModelKey,
  logAssistantModelKeyFailure: mocks.logAssistantModelKeyFailure,
  AssistantModelKeyExistsError: mocks.AssistantModelKeyExistsError,
  AssistantModelKeyKekUnsetError: mocks.AssistantModelKeyKekUnsetError,
}));

import { ensureAssistantModelKey } from "./assistant-key-provision";
import { OpenRouterProvisioningError } from "./openrouter-provisioning";

const ARGS = {
  orgId: "00000000-0000-4000-8000-0000000000aa",
  orgSlug: "acme-corp",
  creatorEmail: "dana@acme.example",
  actorUserId: "user-1",
};

const MINTED = {
  key: { hash: "hash-abc", name: "oxagen/acme-corp/dana@acme.example" },
  apiKey: "sk-or-v1-the-plaintext",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  vi.stubEnv("OPENROUTER_MANAGEMENT_KEY", "sk-or-v1-management");
  vi.stubEnv("OPENROUTER_ORG_KEY_DAILY_LIMIT_USD", "25");

  mocks.hasAssistantModelKey.mockImplementation(async () => {
    mocks.order.push("read");
    return false;
  });
  mocks.createAssistantKey.mockImplementation(async () => {
    mocks.order.push("mint");
    return MINTED;
  });
  mocks.recordAssistantModelKey.mockImplementation(async () => {
    mocks.order.push("store");
  });
  mocks.deleteAssistantKey.mockImplementation(async () => {
    mocks.order.push("unwind");
  });
});

describe("ensureAssistantModelKey — the happy path", () => {
  it("reads, then mints, then stores, in that order", async () => {
    // Minting before writing means a crash between them leaves an orphan an
    // operator can clean up, not a row claiming a key that does not exist —
    // which would fail every turn for that organisation.
    await expect(ensureAssistantModelKey(ARGS)).resolves.toEqual({
      provisioned: true,
    });
    expect(mocks.order).toEqual(["read", "mint", "store"]);
  });

  it("mints under the name the organisation and its creator earn, with a daily ceiling", async () => {
    await ensureAssistantModelKey(ARGS);
    expect(mocks.createAssistantKey).toHaveBeenCalledWith({
      name: "oxagen/acme-corp/dana@acme.example",
      limitUsd: 25,
      limitReset: "daily",
      managementKey: "sk-or-v1-management",
    });
  });

  it("stores the hash, the name and the ceiling beside the key", async () => {
    await ensureAssistantModelKey(ARGS);
    expect(mocks.recordAssistantModelKey).toHaveBeenCalledWith({
      orgId: ARGS.orgId,
      apiKey: "sk-or-v1-the-plaintext",
      keyHash: "hash-abc",
      keyName: "oxagen/acme-corp/dana@acme.example",
      dailyLimitUsd: 25,
      actorUserId: "user-1",
    });
  });

  it("attributes a backfill with no actor to nobody rather than to a guess", async () => {
    await ensureAssistantModelKey({
      orgId: ARGS.orgId,
      orgSlug: ARGS.orgSlug,
      creatorEmail: ARGS.creatorEmail,
    });
    expect(
      mocks.recordAssistantModelKey.mock.calls[0]![0].actorUserId,
    ).toBeNull();
  });
});

describe("ensureAssistantModelKey — the ceiling", () => {
  it("takes the configured ceiling", async () => {
    vi.stubEnv("OPENROUTER_ORG_KEY_DAILY_LIMIT_USD", "50");
    await ensureAssistantModelKey(ARGS);
    expect(mocks.createAssistantKey.mock.calls[0]![0].limitUsd).toBe(50);
  });

  it("falls back to the schema default rather than minting an uncapped key", async () => {
    // The direction that matters for a blast-radius ceiling: a key that
    // exists with a sane cap beats no key, and both beat a key with no cap.
    for (const bad of ["", "nonsense", "0", "-5"]) {
      vi.stubEnv("OPENROUTER_ORG_KEY_DAILY_LIMIT_USD", bad);
      mocks.createAssistantKey.mockClear();
      await ensureAssistantModelKey(ARGS);
      expect([
        bad,
        mocks.createAssistantKey.mock.calls[0]![0].limitUsd,
      ]).toEqual([bad, 25]);
    }
  });
});

describe("ensureAssistantModelKey — not provisioning is not an error", () => {
  it("is off, and costs nothing, where no management key is configured", async () => {
    // Every developer laptop. It must not call the vendor and must not warn.
    vi.stubEnv("OPENROUTER_MANAGEMENT_KEY", "");
    await expect(ensureAssistantModelKey(ARGS)).resolves.toEqual({
      provisioned: false,
      reason: "disabled",
    });
    expect(mocks.order).toEqual([]);
  });

  it("costs one indexed read and no vendor call when the organisation already has a key", async () => {
    mocks.hasAssistantModelKey.mockImplementation(async () => {
      mocks.order.push("read");
      return true;
    });
    await expect(ensureAssistantModelKey(ARGS)).resolves.toEqual({
      provisioned: false,
      reason: "already",
    });
    expect(mocks.order).toEqual(["read"]);
  });

  it("reports a vendor outage as `error` and mints nothing to clean up", async () => {
    mocks.createAssistantKey.mockRejectedValue(
      new OpenRouterProvisioningError(503, "upstream"),
    );
    await expect(ensureAssistantModelKey(ARGS)).resolves.toEqual({
      provisioned: false,
      reason: "error",
    });
    expect(mocks.deleteAssistantKey).not.toHaveBeenCalled();
    expect(mocks.logAssistantModelKeyFailure).toHaveBeenCalledWith(
      ARGS.orgId,
      expect.any(Error),
      "mint",
    );
  });
});

describe("ensureAssistantModelKey — the race, and the unwind", () => {
  it("deletes the key it just minted when another caller won the insert", async () => {
    // The read in step 1 is an optimisation; the `org_id` unique index is the
    // real idempotence. The loser must not leave a second spendable key
    // behind with no row to find it by.
    mocks.recordAssistantModelKey.mockImplementation(async () => {
      mocks.order.push("store");
      throw new mocks.AssistantModelKeyExistsError("already has one");
    });

    await expect(ensureAssistantModelKey(ARGS)).resolves.toEqual({
      provisioned: false,
      reason: "race",
    });
    expect(mocks.order).toEqual(["read", "mint", "store", "unwind"]);
    expect(mocks.deleteAssistantKey).toHaveBeenCalledWith({
      hash: "hash-abc",
      managementKey: "sk-or-v1-management",
    });
  });

  it("does not log a race as a failure, because it is an ordinary outcome", async () => {
    mocks.recordAssistantModelKey.mockRejectedValue(
      new mocks.AssistantModelKeyExistsError("already has one"),
    );
    await ensureAssistantModelKey(ARGS);
    expect(mocks.logAssistantModelKeyFailure).not.toHaveBeenCalled();
  });

  it("unwinds and reports `error` when the key cannot be enveloped", async () => {
    // No encryption key configured: the plaintext cannot be stored, so the
    // key at the vendor is unreachable and must not be left spending.
    mocks.recordAssistantModelKey.mockRejectedValue(
      new mocks.AssistantModelKeyKekUnsetError("no KEK"),
    );
    await expect(ensureAssistantModelKey(ARGS)).resolves.toEqual({
      provisioned: false,
      reason: "error",
    });
    expect(mocks.deleteAssistantKey).toHaveBeenCalledTimes(1);
    expect(mocks.logAssistantModelKeyFailure).toHaveBeenCalledWith(
      ARGS.orgId,
      expect.any(Error),
      "store",
    );
  });

  it("survives a failed unwind rather than throwing on the signup path", async () => {
    // The caller has already failed to provision. Throwing here would replace
    // "this organisation serves on the shared key" — recoverable — with an
    // exception during signup. The orphan shows up in the reconciliation
    // report, which is what that report is for.
    mocks.recordAssistantModelKey.mockRejectedValue(new Error("pg down"));
    mocks.deleteAssistantKey.mockRejectedValue(
      new OpenRouterProvisioningError(503, "vendor down too"),
    );

    await expect(ensureAssistantModelKey(ARGS)).resolves.toEqual({
      provisioned: false,
      reason: "error",
    });
    // Both the unwind failure and the store failure are reported.
    expect(mocks.logAssistantModelKeyFailure).toHaveBeenCalledTimes(2);
  });

  it("never throws, whichever half fails", async () => {
    // It runs detached from organisation creation; an unhandled rejection
    // here is a signup that logs a crash for a key nobody was waiting on.
    const failures = [
      () => mocks.hasAssistantModelKey.mockRejectedValue(new Error("read")),
      () => mocks.createAssistantKey.mockRejectedValue(new Error("mint")),
      () => mocks.recordAssistantModelKey.mockRejectedValue(new Error("store")),
    ];
    for (const [i, fail] of failures.entries()) {
      vi.clearAllMocks();
      mocks.hasAssistantModelKey.mockResolvedValue(false);
      mocks.createAssistantKey.mockResolvedValue(MINTED);
      mocks.recordAssistantModelKey.mockResolvedValue(undefined);
      mocks.deleteAssistantKey.mockResolvedValue(undefined);
      fail();
      // The read is the one failure that is genuinely the caller's to see:
      // it happens before anything was created, so there is nothing to
      // unwind and nothing to be inconsistent about.
      const result = ensureAssistantModelKey(ARGS);
      if (i === 0) {
        await expect(result).rejects.toThrow("read");
      } else {
        await expect(result).resolves.toMatchObject({ provisioned: false });
      }
    }
  });
});
