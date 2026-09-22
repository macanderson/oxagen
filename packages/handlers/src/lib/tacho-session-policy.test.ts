/**
 * The workspace's wrapped-session policy, as the bundle path reads it.
 *
 * The four behaviours asserted here are the ones a reader cannot verify by
 * looking at the normalizer:
 *
 *   1. No row is observed-only. That is what every host had before the table,
 *      and a workspace that has never opened the settings must not change
 *      behaviour the day the migration lands.
 *   2. A missing table is also observed-only, not an exception. This read is
 *      on the bundle path, which ingest, control polls and enrollment all
 *      walk, and 42P01 would abort the transaction for all three.
 *   3. `modelAllow` null and `[]` survive the round trip apart.
 *   4. A stored mode outside the two the check constraint allows reads as the
 *      safe one. An unknown word must not arm a gateway.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const tableReady = vi.fn(async () => true);
vi.mock("./tacho-gateway-columns", () => ({
  tachoSessionPolicyTableReady: () => tableReady(),
}));

const { OBSERVED_ONLY, hasEnforceableClause, readTachoSessionPolicyIn } =
  await import("./tacho-session-policy");

/** A transaction whose one query answers with `row`. */
function tx(row: unknown) {
  return {
    query: { tachoSessionPolicy: { findFirst: async () => row } },
  } as never;
}

beforeEach(() => {
  tableReady.mockReset();
  tableReady.mockResolvedValue(true);
});

describe("readTachoSessionPolicyIn", () => {
  it("reads no row as observed-only", async () => {
    expect(await readTachoSessionPolicyIn(tx(undefined), "ws")).toEqual(
      OBSERVED_ONLY,
    );
  });

  it("reads a missing table as observed-only without touching the query", async () => {
    tableReady.mockResolvedValue(false);
    const findFirst = vi.fn();
    const policy = await readTachoSessionPolicyIn(
      { query: { tachoSessionPolicy: { findFirst } } } as never,
      "ws",
    );
    expect(policy).toEqual(OBSERVED_ONLY);
    // Not merely a caught error: the absent table is never named at all.
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("keeps a null allowlist apart from an empty one", async () => {
    const noList = await readTachoSessionPolicyIn(
      tx({
        mode: "enforced",
        sessionLimitUsd: 5,
        modelAllow: null,
        modelDeny: [],
      }),
      "ws",
    );
    expect(noList.modelAllow).toBeNull();
    const permitsNothing = await readTachoSessionPolicyIn(
      tx({
        mode: "enforced",
        sessionLimitUsd: null,
        modelAllow: [],
        modelDeny: [],
      }),
      "ws",
    );
    expect(permitsNothing.modelAllow).toEqual([]);
  });

  it("reads an unrecognised mode as observed", async () => {
    const policy = await readTachoSessionPolicyIn(
      tx({
        mode: "ENFORCED",
        sessionLimitUsd: 5,
        modelAllow: null,
        modelDeny: [],
      }),
      "ws",
    );
    expect(policy.mode).toBe("observed");
  });

  it("drops a non-string entry rather than putting it on the wire", async () => {
    const policy = await readTachoSessionPolicyIn(
      tx({
        mode: "enforced",
        sessionLimitUsd: null,
        modelAllow: ["gpt-5", 7, null],
        modelDeny: "not-a-list",
      }),
      "ws",
    );
    expect(policy.modelAllow).toEqual(["gpt-5"]);
    expect(policy.modelDeny).toEqual([]);
  });
});

describe("hasEnforceableClause", () => {
  it("is false only when there is genuinely nothing to refuse on", () => {
    expect(hasEnforceableClause(OBSERVED_ONLY)).toBe(false);
    expect(hasEnforceableClause({ ...OBSERVED_ONLY, sessionLimitUsd: 5 })).toBe(
      true,
    );
    // An allowlist that permits nothing is a decision, so it counts.
    expect(hasEnforceableClause({ ...OBSERVED_ONLY, modelAllow: [] })).toBe(
      true,
    );
    expect(
      hasEnforceableClause({ ...OBSERVED_ONLY, modelDeny: ["gpt-4o"] }),
    ).toBe(true);
  });
});
