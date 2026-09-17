/**
 * Unit tests for the get_run_proof handler (ADR-064).
 *
 * The role gate runs for real against a tx double that answers the principal
 * and role-assignment tables; the proof record and the cost rows are injected,
 * so what is asserted is what the handler makes of them: each attempt under
 * its witness, the latest attempt's verdict per witness, the run's verdict
 * aggregated over the witnesses, the tamper detail, and each witness run's
 * cost. The rows' SQL is asserted against Postgres in lib/proof.pg.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isHandlerError } from "@oxagen/oxagen";
import { schema } from "@oxagen/database";
import type { ProofRecord } from "./lib/proof";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { createRunProofHandler, type RunProofDeps } from "./run.proof.get";
import { makeCTX } from "./test-utils/fixtures";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-0000000c0e01";
const USER = "0192d4a8-7c1e-7a00-8000-0000000005e1";
const RUN = "tse_01k5rq4b9c7xtn2p";
const WITNESS_RUN = "tse_01k5rq5w7t2hvn9k";
const d = (c: string) => `sha256:${c.repeat(64)}`;

const ctx = (over: { userId?: string | null; apiKeyId?: string | null } = {}) =>
  makeCTX({
    orgId: ORG,
    workspaceId: WS,
    userId: USER,
    apiKeyId: null,
    ...over,
  });

/** Answers the role gate by the table asked for, so query order does not matter. */
function stubRole(roleName: string | null) {
  const rowsFor = (table: unknown): unknown[] => {
    if (table === schema.principals) return [{ id: "prn_1" }];
    if (table === schema.principalRoleAssignments)
      return roleName ? [{ roleName }] : [];
    throw new Error("unexpected table");
  };
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(
      fn({
        select: () => ({
          from: (table: unknown) => {
            const chain = {
              innerJoin: () => chain,
              where: () => chain,
              limit: () => Promise.resolve(rowsFor(table)),
            };
            return chain;
          },
        }),
      }),
    ),
  );
}

type AttemptRow = ProofRecord["attempts"][number];
type WitnessRow = ProofRecord["witnesses"][number];

function attemptRow(over: Partial<AttemptRow> = {}): AttemptRow {
  return {
    id: "0192d4a8-7c1e-7a00-8000-000000000a01",
    orgId: ORG,
    workspaceId: WS,
    createdAt: new Date("2026-09-15T09:09:34.000Z"),
    createdById: null,
    runId: RUN,
    sessionUuid: "0192d4a8-7c1e-7a00-8000-00000000f001",
    frameSeq: 71,
    observedAt: new Date("2026-09-15T09:09:33.201Z"),
    witnessId: "wit_A",
    attemptNo: 1,
    witnessRunId: WITNESS_RUN,
    targetRef: "main",
    targetSha: "a4c91e2",
    prRef: "refs/pull/482/head",
    prSha: "f70b3d9",
    targetResult: "fail",
    prResult: "pass",
    verdict: "flipped",
    failFingerprint: d("2"),
    passOutputDigest: d("3"),
    tamperExclusion: "held",
    tamper: null,
    disclosureGrain: "L0",
    runnerAttestation: { key_id: "kms:witness/v3", signature: "MEUCIQ" },
    ...over,
  };
}

function witnessRow(over: Partial<WitnessRow> = {}): WitnessRow {
  return {
    id: "0192d4a8-7c1e-7a00-8000-000000000b01",
    orgId: ORG,
    workspaceId: WS,
    createdAt: new Date("2026-09-15T09:03:30.000Z"),
    createdById: null,
    witnessId: "wit_A",
    oracleKind: "test_flip",
    commandDigest: d("1"),
    heldOut: false,
    ...over,
  };
}

function handler(
  record: ProofRecord,
  totals: RunProofDeps["readRunTotalsByIds"] = async () => new Map(),
) {
  const readRunProof = vi.fn(async () => record);
  const readRunTotalsByIds = vi.fn(totals);
  return {
    get: createRunProofHandler({ readRunProof, readRunTotalsByIds }),
    readRunProof,
    readRunTotalsByIds,
  };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    if (isHandlerError(err)) return { code: err.code, reason: err.reason };
    throw err;
  }
  throw new Error("expected a refusal");
}

beforeEach(() => {
  vi.clearAllMocks();
  stubRole("Member");
});

describe("get_run_proof", () => {
  it("answers the none state for a run no witness reported on", async () => {
    const { get, readRunProof, readRunTotalsByIds } = handler({
      attempts: [],
      witnesses: [],
      grain: "L0",
    });
    const out = await get({ runId: RUN }, ctx());
    expect(out).toEqual({
      runId: RUN,
      verdict: null,
      witnesses: [],
      witnessRuns: [],
      disclosureGrain: "L0",
    });
    expect(readRunProof).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WS },
      RUN,
    );
    expect(readRunTotalsByIds).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WS },
      [],
    );
  });

  it.each([
    ["flipped", { targetResult: "fail", prResult: "pass" }],
    [
      "failing",
      { targetResult: "fail", prResult: "fail", passOutputDigest: null },
    ],
    [
      "unmoved",
      { targetResult: "pass", prResult: "pass", failFingerprint: null },
    ],
    [
      "unsatisfied",
      { targetResult: "fail", prResult: "fail", passOutputDigest: null },
    ],
    ["unverified", { prResult: "inconclusive", passOutputDigest: null }],
    [
      "waived",
      {
        targetResult: "inconclusive",
        prResult: "inconclusive",
        failFingerprint: null,
        passOutputDigest: null,
      },
    ],
  ] as const)(
    "maps a %s attempt to the same verdict on the witness and the run",
    async (verdict, over) => {
      const { get } = handler({
        attempts: [attemptRow({ verdict, ...over })],
        witnesses: [witnessRow()],
        grain: "L0",
      });
      const out = await get({ runId: RUN }, ctx());
      expect(out.verdict).toBe(verdict);
      expect(out.witnesses[0]?.verdict).toBe(verdict);
    },
  );

  it("maps a tampered attempt with its fingerprints, and the run credits nothing", async () => {
    const { get } = handler({
      attempts: [
        attemptRow({
          verdict: "tampered",
          prResult: "excluded",
          passOutputDigest: null,
          tamperExclusion: "broken",
          tamper: { fingerprint_authored: d("4"), fingerprint_at_run: d("5") },
        }),
      ],
      witnesses: [witnessRow()],
      grain: "L0",
    });
    const out = await get({ runId: RUN }, ctx());
    expect(out.verdict).toBe("tampered");
    expect(out.witnesses[0]?.attempts[0]).toMatchObject({
      prResult: "excluded",
      tamperExclusion: "broken",
      tamper: { fingerprintAuthored: d("4"), fingerprintAtRun: d("5") },
    });
  });

  it("keeps attempts under their witness in frame order, the latest deciding each witness", async () => {
    const { get } = handler({
      attempts: [
        attemptRow({
          frameSeq: 33,
          attemptNo: 1,
          verdict: "failing",
          prResult: "fail",
          passOutputDigest: null,
        }),
        attemptRow({
          frameSeq: 40,
          witnessId: "wit_B",
          attemptNo: 1,
          verdict: "unmoved",
          targetResult: "pass",
        }),
        attemptRow({ frameSeq: 71, attemptNo: 2, verdict: "flipped" }),
      ],
      witnesses: [
        witnessRow(),
        witnessRow({
          witnessId: "wit_B",
          heldOut: true,
          oracleKind: "property",
        }),
      ],
      grain: "L1",
    });
    const out = await get({ runId: RUN }, ctx());
    expect(
      out.witnesses.map((w) => [w.witnessId, w.verdict, w.heldOut]),
    ).toEqual([
      ["wit_A", "flipped", false],
      ["wit_B", "unmoved", true],
    ]);
    expect(
      out.witnesses[0]?.attempts.map((a) => [a.attemptNo, a.frameSeq]),
    ).toEqual([
      [1, "33"],
      [2, "71"],
    ]);
    // A held-out witness that did not flip keeps the run from reading proven.
    expect(out.verdict).toBe("unmoved");
    expect(out.disclosureGrain).toBe("L1");
  });

  it("answers each witness run once with its cost, or null before the rollup priced it", async () => {
    const OTHER = "tse_01k5rq6x0000000000";
    const { get, readRunTotalsByIds } = handler(
      {
        attempts: [
          attemptRow({ frameSeq: 33, attemptNo: 1 }),
          attemptRow({ frameSeq: 71, attemptNo: 2 }),
          attemptRow({ frameSeq: 80, witnessId: "wit_B", witnessRunId: OTHER }),
        ],
        witnesses: [witnessRow(), witnessRow({ witnessId: "wit_B" })],
        grain: "L0",
      },
      async () =>
        new Map([
          [
            WITNESS_RUN,
            {
              costMicros: 610_000n,
              currency: "USD",
              costBasis: "gateway_observed",
            } as never,
          ],
        ]),
    );
    const out = await get({ runId: RUN }, ctx());
    expect(readRunTotalsByIds).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WS },
      [WITNESS_RUN, OTHER],
    );
    expect(out.witnessRuns).toEqual([
      {
        runId: WITNESS_RUN,
        cost: { micros: "610000", currency: "USD", basis: "gateway_observed" },
      },
      { runId: OTHER, cost: null },
    ]);
  });

  it("refuses an API-key caller before any read, whoever minted the key (negative)", async () => {
    const { get, readRunProof } = handler({
      attempts: [],
      witnesses: [],
      grain: "L0",
    });
    expect(
      await refusal(get({ runId: RUN }, ctx({ apiKeyId: "aky_worker" }))),
    ).toEqual({
      code: "forbidden",
      reason: "session_required",
    });
    expect(readRunProof).not.toHaveBeenCalled();
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("refuses a signed-in user with no role in the org (negative)", async () => {
    stubRole(null);
    const { get, readRunProof } = handler({
      attempts: [],
      witnesses: [],
      grain: "L0",
    });
    expect(await refusal(get({ runId: RUN }, ctx()))).toMatchObject({
      code: "forbidden",
    });
    expect(readRunProof).not.toHaveBeenCalled();
  });

  it("fails on a verdict row that names no witness row rather than inventing one (negative)", async () => {
    const { get } = handler({
      attempts: [attemptRow()],
      witnesses: [],
      grain: "L0",
    });
    await expect(get({ runId: RUN }, ctx())).rejects.toThrow(RangeError);
  });
});
