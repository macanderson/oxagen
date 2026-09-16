// The witness record against a real Postgres (ADR-064): the ingest writer
// records one attempt per `proof.observed` frame with its number in frame
// order, refuses a witness whose identity moved and every witness run link
// the rollup could not act on, and the migration's CHECKs refuse a flip the
// results do not show; the proof read, the witness-run
// lookup and the run verdict read it back inside the tenant; the grain writer
// changes the row once and answers a no-op with the recorded instant. Runs
// wherever DATABASE_URL points at a migrated database — CI's `test` job
// migrates Postgres with Atlas before `turbo run build test:unit`; a local run
// without one is skipped, not red. Every row it writes is removed in afterAll.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeDatabase,
  readRunVerdict,
  schema,
  withSystemDb,
  withTenantDb,
} from "@oxagen/database";
import { isHandlerError } from "@oxagen/oxagen";
import {
  GENESIS_CURSOR,
  type ChainCursor,
  type TachoEvent,
  type UnsealedTachoEvent,
  sealEvent,
} from "@oxagen/tacho";
import { runInTenantScope } from "@oxagen/tenancy";
import { eq } from "drizzle-orm";
import {
  readRunProof,
  readWitnessFor,
  recordProofFrames,
  writeDisclosureGrain,
} from "./proof";

const enabled = Boolean(process.env.DATABASE_URL);
const d = (c: string) => `sha256:${c.repeat(64)}`;

describe.skipIf(!enabled)("the witness record against Postgres", () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const scope = {
    orgId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
  };
  const other = { orgId: scope.orgId, workspaceId: crypto.randomUUID() };
  const run = `tse_${tag}worker`.toLowerCase();
  const witnessRun = `tse_${tag}witness`.toLowerCase();
  const ownRun = `tse_${tag}ownrun`;
  const subRun = `tse_${tag}subagent`;
  const foreignRun = `tse_${tag}foreign`;
  const userId = crypto.randomUUID();
  const invalid = ["conflict", "witness_run_invalid"];

  const scoped = <T>(s: typeof scope, fn: () => Promise<T>) =>
    runInTenantScope(s, fn);

  function body(over: Record<string, unknown> = {}) {
    return {
      witness_id: `wit_${tag}`,
      oracle: "test_flip",
      target_ref: "main",
      target_sha: "a4c91e2",
      pr_ref: "refs/pull/482/head",
      pr_sha: "f70b3d9",
      command_normalized_digest: d("1"),
      target_result: "fail",
      pr_result: "fail",
      verdict: "failing",
      fail_fingerprint: d("2"),
      pass_output_digest: null,
      tamper_exclusion: "held",
      disclosure_grain: "L0",
      witness_run_id: witnessRun,
      runner_attestation: { key_id: "kms:witness/v3", signature: "MEUCIQ" },
      ...over,
    };
  }

  /** A chain of `proof.observed` frames starting at `start`. */
  function frames(bodies: Record<string, unknown>[], start = 5): TachoEvent[] {
    let cursor: ChainCursor = { ...GENESIS_CURSOR, seq: start };
    return bodies.map((b, i) => {
      const sealed = sealEvent(
        {
          v: "tacho/1.0",
          event_id: `evt_01ARZ3NDEKTSV4RRFFQ69G5F${String(i).padStart(2, "0")}`,
          session_id: "sess-1",
          session_uuid: "0192d4a8-7c1e-7a00-8000-00000000f001",
          root_session_uuid: "0192d4a8-7c1e-7a00-8000-00000000f001",
          ts: `2026-09-15T09:0${i}:00.000Z`,
          fidelity: "sdk",
          source: "hook",
          agent: {
            agent_key: "acme.core.cc-laptop",
            fleet_id: "wrk_1",
            runtime: "claude-code",
            harness: "claude-code",
            wrapper_version: "2.1.1",
          },
          kind: "proof.observed",
          body: b,
        } satisfies UnsealedTachoEvent,
        cursor,
      );
      cursor = sealed.next;
      return sealed.event;
    });
  }

  /** A wrapped session: a root run unless it names a parent. */
  function session(
    s: typeof scope,
    publicId: string,
    parentSessionUuid: string | null = null,
  ) {
    const sessionUuid = crypto.randomUUID();
    return {
      ...s,
      publicId,
      sessionUuid,
      harnessSessionId: `sess-${publicId}`,
      agentKey: "acme.core.cc-laptop",
      rootSessionUuid: parentSessionUuid ?? sessionUuid,
      parentSessionUuid,
      runtime: "claude-code",
      harness: "claude-code",
      startedAt: new Date("2026-09-15T09:00:00.000Z"),
      lastEventAt: new Date("2026-09-15T09:05:00.000Z"),
    };
  }

  beforeAll(async () => {
    await withSystemDb(async (tx) => {
      await tx
        .insert(schema.tachoSessions)
        .values([
          session(scope, witnessRun),
          session(scope, ownRun),
          session(scope, subRun, crypto.randomUUID()),
          session(other, foreignRun),
        ]);
    });
  });

  /** The code and reason `recordProofFrames` refuses one frame on `runId` with. */
  async function refusal(
    runId: string,
    over: Record<string, unknown>,
    seq: number,
  ) {
    const err = await scoped(scope, () =>
      withTenantDb((tx) =>
        recordProofFrames(tx, scope, runId, frames([body(over)], seq)),
      ),
    ).catch((e: unknown) => e);
    return isHandlerError(err) && [err.code, err.reason];
  }

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      for (const s of [scope, other]) {
        await tx
          .delete(schema.tachoSessions)
          .where(eq(schema.tachoSessions.workspaceId, s.workspaceId));
        await tx
          .delete(schema.verdicts)
          .where(eq(schema.verdicts.workspaceId, s.workspaceId));
        await tx
          .delete(schema.witnesses)
          .where(eq(schema.witnesses.workspaceId, s.workspaceId));
        await tx
          .delete(schema.disclosurePolicies)
          .where(eq(schema.disclosurePolicies.workspaceId, s.workspaceId));
      }
    });
    await closeDatabase();
  });

  it("records each proof frame as an attempt numbered in frame order and reads it back", async () => {
    const written = await scoped(scope, () =>
      withTenantDb((tx) =>
        recordProofFrames(
          tx,
          scope,
          run,
          frames([
            body(),
            body({ pr_sha: "9d04a3e" }),
            body({
              pr_sha: "0c11d7e",
              pr_result: "pass",
              verdict: "flipped",
              pass_output_digest: d("3"),
            }),
          ]),
        ),
      ),
    );
    expect(written).toEqual({ written: 3, witnessRunIds: [witnessRun] });

    const record = await scoped(scope, () => readRunProof(scope, run));
    expect(
      record.attempts.map((a) => [a.attemptNo, a.frameSeq, a.verdict]),
    ).toEqual([
      [1, 5, "failing"],
      [2, 6, "failing"],
      [3, 7, "flipped"],
    ]);
    expect(record.witnesses).toHaveLength(1);
    expect(record.witnesses[0]).toMatchObject({
      witnessId: `wit_${tag}`,
      oracleKind: "test_flip",
      heldOut: false,
    });
    expect(record.grain).toBe("L0");
    expect(
      await scoped(scope, () =>
        withTenantDb((tx) => readRunVerdict(tx, scope, run)),
      ),
    ).toBe("flipped");
    expect(await scoped(scope, () => readWitnessFor(scope, witnessRun))).toBe(
      run,
    );
  });

  it("writes nothing for a frame already recorded", async () => {
    const again = await scoped(scope, () =>
      withTenantDb((tx) => recordProofFrames(tx, scope, run, frames([body()]))),
    );
    expect(again).toEqual({ written: 0, witnessRunIds: [] });
    const record = await scoped(scope, () => readRunProof(scope, run));
    expect(record.attempts).toHaveLength(3);
  });

  it("refuses a witness run that is the run itself (negative)", async () => {
    expect(await refusal(run, { witness_run_id: run }, 30)).toEqual(invalid);
  });

  it("refuses a witness run that is no root run in the workspace: unrecorded, a subagent session, another workspace's run (negative)", async () => {
    expect(
      await refusal(run, { witness_run_id: `tse_${tag}unrecorded` }, 31),
    ).toEqual(invalid);
    expect(await refusal(run, { witness_run_id: subRun }, 32)).toEqual(invalid);
    expect(await refusal(run, { witness_run_id: foreignRun }, 33)).toEqual(
      invalid,
    );
  });

  it("refuses a witness run that carries verdicts of its own (negative)", async () => {
    const own = await scoped(scope, () =>
      withTenantDb((tx) =>
        recordProofFrames(
          tx,
          scope,
          ownRun,
          frames([body({ witness_run_id: null })], 0),
        ),
      ),
    );
    expect(own).toEqual({ written: 1, witnessRunIds: [] });
    expect(await refusal(run, { witness_run_id: ownRun }, 34)).toEqual(invalid);
  });

  it("refuses a witness run another run's verdict already names (negative)", async () => {
    expect(
      await refusal(`tse_${tag}second`, { witness_run_id: witnessRun }, 0),
    ).toEqual(invalid);
    expect(await scoped(scope, () => readWitnessFor(scope, witnessRun))).toBe(
      run,
    );
  });

  it("refuses a verdict on a run that is itself a witness run (negative)", async () => {
    expect(await refusal(witnessRun, { witness_run_id: null }, 0)).toEqual(
      invalid,
    );
  });

  it("refuses a frame that names the witness with another command digest (negative)", async () => {
    const err = await scoped(scope, () =>
      withTenantDb((tx) =>
        recordProofFrames(
          tx,
          scope,
          run,
          frames([body({ command_normalized_digest: d("9") })], 20),
        ),
      ),
    ).catch((e: unknown) => e);
    expect(isHandlerError(err) && [err.code, err.reason]).toEqual([
      "conflict",
      "witness_identity_changed",
    ]);
  });

  it("refuses a flipped row whose results show no flip at the CHECK (negative)", async () => {
    const err = await withSystemDb((tx) =>
      tx.insert(schema.verdicts).values({
        ...scope,
        runId: run,
        sessionUuid: crypto.randomUUID(),
        frameSeq: 99,
        observedAt: new Date(),
        witnessId: `wit_${tag}`,
        attemptNo: 9,
        targetRef: "main",
        targetSha: "a4c91e2",
        prRef: "refs/pull/482/head",
        prSha: "f70b3d9",
        targetResult: "pass",
        prResult: "pass",
        verdict: "flipped",
        tamperExclusion: "held",
        disclosureGrain: "L0",
        runnerAttestation: {},
      }),
    ).catch((e: unknown) => e);
    expect(String((err as { cause?: unknown }).cause ?? err)).toMatch(
      /verdicts_flip_check/,
    );
  });

  it("keeps the record inside its workspace", async () => {
    const record = await scoped(other, () => readRunProof(other, run));
    expect(record.attempts).toEqual([]);
    expect(
      await scoped(other, () => readWitnessFor(other, witnessRun)),
    ).toBeNull();
  });

  it("changes the grain once and answers a repeat with the recorded instant", async () => {
    const none = await scoped(scope, () =>
      writeDisclosureGrain(scope, "L0", userId),
    );
    expect(none).toEqual({
      previous: "L0",
      grain: "L0",
      changedAt: null,
      changed: false,
    });

    const raised = await scoped(scope, () =>
      writeDisclosureGrain(scope, "L2", userId),
    );
    expect(raised).toMatchObject({
      previous: "L0",
      grain: "L2",
      changed: true,
    });

    const repeat = await scoped(scope, () =>
      writeDisclosureGrain(scope, "L2", userId),
    );
    expect(repeat.changed).toBe(false);
    expect(repeat.changedAt?.getTime()).toBe(raised.changedAt?.getTime());

    const lowered = await scoped(scope, () =>
      writeDisclosureGrain(scope, "L1", userId),
    );
    expect(lowered).toMatchObject({
      previous: "L2",
      grain: "L1",
      changed: true,
    });
    expect((await scoped(scope, () => readRunProof(scope, run))).grain).toBe(
      "L1",
    );
  });
});
