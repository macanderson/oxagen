// proof.ts — the witness record in Postgres (Mission Control spec §8.5,
// ADR-064): the rows a `proof.observed` frame writes at ingest, the proof read,
// the workspace's disclosure grain, and the session gate both proof
// capabilities share.
import type { CapabilityContext } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import {
  readWitnessedRunId,
  schema,
  type Tx,
  withTenantDb,
} from "@oxagen/database";
import {
  type DisclosureGrain,
  PROOF_OBSERVED_KIND,
  proofObservedBodySchema,
} from "@oxagen/run-evidence";
import type { TachoEvent } from "@oxagen/tacho";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";

export type ProofScope = { orgId: string; workspaceId: string };

const witnesses = schema.witnesses;
const verdicts = schema.verdicts;
const policies = schema.disclosurePolicies;

/**
 * The signed-in person behind the call, or `forbidden`. The proof record
 * names which witness failed and which were held out, and the grain decides
 * how much a worker learns; a worker holds API keys, so neither is reachable
 * with one (ADR-064 decision 3). The app's kernel seam carries no API key.
 */
export function requireSessionUser(ctx: CapabilityContext): string {
  if (ctx.apiKeyId !== null || ctx.userId === null)
    throw new HandlerError({
      code: "forbidden",
      reason: "session_required",
      message: "Requires a signed-in session; API keys are refused",
    });
  return ctx.userId;
}

/** A stored word checked against its closed vocabulary: a word outside it is a broken row. */
export function closedWord<const T extends readonly string[]>(
  words: T,
  value: string,
): T[number] {
  if (!words.includes(value))
    throw new RangeError(`stored word outside its vocabulary: ${value}`);
  return value;
}

// ── Ingest ────────────────────────────────────────────────────────────────────

/** A run's root in the workspace: a V2 ledger run or a root tacho session. */
async function isRootRun(
  tx: Tx,
  scope: ProofScope,
  runId: string,
): Promise<boolean> {
  if (runId.startsWith("tse_")) {
    const sessions = schema.tachoSessions;
    const [row] = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.orgId, scope.orgId),
          eq(sessions.workspaceId, scope.workspaceId),
          eq(sessions.publicId, runId),
          isNull(sessions.parentSessionUuid),
        ),
      )
      .limit(1);
    return row !== undefined;
  }
  const runs = schema.agentRuns;
  const [row] = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.orgId, scope.orgId),
        eq(runs.workspaceId, scope.workspaceId),
        eq(runs.publicId, runId),
        eq(runs.specVersion, 2),
      ),
    )
    .limit(1);
  return row !== undefined;
}

function witnessRunInvalid(message: string): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "witness_run_invalid",
    message,
  });
}

/**
 * A witness run is a root run of its own in the workspace, reports on exactly
 * one worker run, and carries no verdict of its own: `readWitnessedRunId` and
 * the rollup's operator attribution act on the link, so a link that breaks
 * any of these refuses the batch.
 */
async function assertWitnessRun(
  tx: Tx,
  scope: ProofScope,
  runId: string,
  witnessRunId: string,
): Promise<void> {
  if (witnessRunId === runId)
    throw witnessRunInvalid(`run ${runId} names itself as its witness run`);
  if (!(await isRootRun(tx, scope, witnessRunId)))
    throw witnessRunInvalid(
      `witness run ${witnessRunId} is not a run in this workspace`,
    );
  const inScope = and(
    eq(verdicts.orgId, scope.orgId),
    eq(verdicts.workspaceId, scope.workspaceId),
  );
  const [ownVerdict] = await tx
    .select({ id: verdicts.id })
    .from(verdicts)
    .where(and(inScope, eq(verdicts.runId, witnessRunId)))
    .limit(1);
  if (ownVerdict)
    throw witnessRunInvalid(
      `witness run ${witnessRunId} carries verdicts of its own`,
    );
  const [otherWorker] = await tx
    .select({ id: verdicts.id })
    .from(verdicts)
    .where(
      and(
        inScope,
        eq(verdicts.witnessRunId, witnessRunId),
        ne(verdicts.runId, runId),
      ),
    )
    .limit(1);
  if (otherWorker)
    throw witnessRunInvalid(
      `witness run ${witnessRunId} already reported on another run`,
    );
}

/**
 * One `evidence.verdicts` row per `proof.observed` frame among `events`, which
 * must be frames past their session's recorded head (a re-sent frame is never
 * passed, and the frame's unique key would drop it if it were). `runId` is the
 * run the frames belong to: the root session for a wrapped run, whichever
 * session's chain carried them. A run another verdict names as its witness
 * run takes no verdict, and each witness run a frame names passes
 * `assertWitnessRun`. The witness row is written on first sight; a frame that
 * names a known witness with another oracle, command digest or held-out flag
 * refuses the batch. Returns how many rows were written and the distinct
 * witness run ids those rows name: each witness run's cost row is rebuilt once
 * its verdict exists.
 */
export async function recordProofFrames(
  tx: Tx,
  scope: ProofScope,
  runId: string,
  events: readonly TachoEvent[],
): Promise<{ written: number; witnessRunIds: string[] }> {
  let written = 0;
  const witnessRunIds = new Set<string>();
  const proofs = events.filter((event) => event.kind === PROOF_OBSERVED_KIND);
  if (proofs.length > 0 && (await readWitnessedRunId(tx, scope, runId)))
    throw witnessRunInvalid(
      `run ${runId} is a witness run and takes no verdict`,
    );
  for (const event of proofs) {
    // The contract validated the body; parsing again applies its defaults.
    const body = proofObservedBodySchema.parse(event.body);
    if (body.witness_run_id !== null)
      await assertWitnessRun(tx, scope, runId, body.witness_run_id);
    const inScope = and(
      eq(witnesses.orgId, scope.orgId),
      eq(witnesses.workspaceId, scope.workspaceId),
      eq(witnesses.witnessId, body.witness_id),
    );
    await tx
      .insert(witnesses)
      .values({
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        witnessId: body.witness_id,
        oracleKind: body.oracle,
        commandDigest: body.command_normalized_digest,
        heldOut: body.held_out,
      })
      .onConflictDoNothing();
    const [known] = await tx
      .select({
        oracleKind: witnesses.oracleKind,
        commandDigest: witnesses.commandDigest,
        heldOut: witnesses.heldOut,
      })
      .from(witnesses)
      .where(inScope)
      .limit(1);
    if (
      !known ||
      known.oracleKind !== body.oracle ||
      known.commandDigest !== body.command_normalized_digest ||
      known.heldOut !== body.held_out
    )
      throw new HandlerError({
        code: "conflict",
        reason: "witness_identity_changed",
        message: `witness ${body.witness_id} was recorded with another oracle, command or held-out flag`,
      });

    const [prior] = await tx
      .select({ attempts: sql<number>`count(*)::int` })
      .from(verdicts)
      .where(
        and(
          eq(verdicts.orgId, scope.orgId),
          eq(verdicts.workspaceId, scope.workspaceId),
          eq(verdicts.runId, runId),
          eq(verdicts.witnessId, body.witness_id),
        ),
      );
    const inserted = await tx
      .insert(verdicts)
      .values({
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        runId,
        sessionUuid: event.session_uuid,
        frameSeq: event.seq,
        observedAt: new Date(event.ts),
        witnessId: body.witness_id,
        attemptNo: (prior?.attempts ?? 0) + 1,
        witnessRunId: body.witness_run_id,
        targetRef: body.target_ref,
        targetSha: body.target_sha,
        prRef: body.pr_ref,
        prSha: body.pr_sha,
        targetResult: body.target_result,
        prResult: body.pr_result,
        verdict: body.verdict,
        failFingerprint: body.fail_fingerprint,
        passOutputDigest: body.pass_output_digest,
        tamperExclusion: body.tamper_exclusion,
        tamper: body.tamper ?? null,
        disclosureGrain: body.disclosure_grain,
        runnerAttestation: body.runner_attestation,
      })
      .onConflictDoNothing()
      .returning({ id: verdicts.id });
    written += inserted.length;
    if (inserted.length > 0 && body.witness_run_id !== null)
      witnessRunIds.add(body.witness_run_id);
  }
  return { written, witnessRunIds: [...witnessRunIds] };
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export type ProofRecord = {
  /** In attempt order: per witness, the last row is its latest attempt. */
  attempts: (typeof verdicts.$inferSelect)[];
  witnesses: (typeof witnesses.$inferSelect)[];
  grain: DisclosureGrain;
};

async function readPolicy(tx: Tx, scope: ProofScope) {
  const [row] = await tx
    .select({ grain: policies.grain, updatedAt: policies.updatedAt })
    .from(policies)
    .where(
      and(
        eq(policies.orgId, scope.orgId),
        eq(policies.workspaceId, scope.workspaceId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Every verdict row of the run in attempt order, the witnesses they name, and the workspace's grain. */
export function readRunProof(
  scope: ProofScope,
  runId: string,
): Promise<ProofRecord> {
  return withTenantDb(async (tx) => {
    const attempts = await tx
      .select()
      .from(verdicts)
      .where(
        and(
          eq(verdicts.orgId, scope.orgId),
          eq(verdicts.workspaceId, scope.workspaceId),
          eq(verdicts.runId, runId),
        ),
      )
      .orderBy(asc(verdicts.attemptNo), asc(verdicts.observedAt));
    const ids = [...new Set(attempts.map((row) => row.witnessId))];
    const named =
      ids.length === 0
        ? []
        : await tx
            .select()
            .from(witnesses)
            .where(
              and(
                eq(witnesses.orgId, scope.orgId),
                eq(witnesses.workspaceId, scope.workspaceId),
                inArray(witnesses.witnessId, ids),
              ),
            );
    const policy = await readPolicy(tx, scope);
    return {
      attempts,
      witnesses: named,
      grain: (policy?.grain ?? "L0") as DisclosureGrain,
    };
  });
}

/** The worker run a witness run was for, in the caller's workspace; null for any other run. */
export function readWitnessFor(
  scope: ProofScope,
  runId: string,
): Promise<string | null> {
  return withTenantDb((tx) => readWitnessedRunId(tx, scope, runId));
}

// ── The disclosure grain ──────────────────────────────────────────────────────

type GrainChange = {
  previous: DisclosureGrain;
  grain: DisclosureGrain;
  /** When the stored grain last changed; null when nothing was ever stored. */
  changedAt: Date | null;
  changed: boolean;
};

/**
 * Store the workspace's grain. Asking for the grain already in force writes
 * nothing and answers the recorded instant (null for a workspace that never
 * set one and asked for `L0`).
 */
export function writeDisclosureGrain(
  scope: ProofScope,
  grain: DisclosureGrain,
  userId: string,
): Promise<GrainChange> {
  return withTenantDb(async (tx) => {
    const current = await readPolicy(tx, scope);
    const previous = (current?.grain ?? "L0") as DisclosureGrain;
    if (previous === grain)
      return {
        previous,
        grain,
        changedAt: current?.updatedAt ?? null,
        changed: false,
      };
    const now = new Date();
    await tx
      .insert(policies)
      .values({
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        grain,
        createdAt: now,
        updatedAt: now,
        createdById: userId,
        updatedById: userId,
      })
      .onConflictDoUpdate({
        target: [policies.orgId, policies.workspaceId],
        set: { grain, updatedAt: now, updatedById: userId },
      });
    return { previous, grain, changedAt: now, changed: true };
  });
}
