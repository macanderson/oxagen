// `fork_run`: a new attempt that replays the recording up to a frame
// (Mission Control spec §8.4 `fork`; ADR-058 decision 3).
//
// Guards, in order, each with its negative test:
//   1. Role: org Owner, Admin or Member (`assertOrgRole`, ARCHITECTURE.md
//      §3.2), for the signed-in user or the creator of the API key
//      (`resolveActingUserId`); the kernel's IAM check allows everything for a non-enterprise
//      org, so the handler is where a Viewer is refused.
//   2. The run is in the caller's workspace (`not_found`) and is a ledger run
//      (`conflict`, `fork_requires_ledger_run`): a wrapped session can record
//      `fork`, and has no attempt row to mint, so its fork is refused by name
//      (ADR-058 decision 3).
//   3. The run has a sealed attempt whose recorded grade allows `fork`
//      (`conflict`, `replay_grade_below_fork`). The grade is read, never
//      recomputed: the seal is the record.
//   4. The branch point lies within the sealed recording (`conflict`,
//      `from_seq_past_seal`).
//   5. Every frame up to the branch point that carried content kept its body
//      (`conflict`, `gap_before_from_seq`): the cassette would otherwise have
//      a hole before the fork.
//   6. The run still takes a new attempt once its row is locked (`conflict`,
//      `run_not_writable` for a cancel or a pause that won the lock,
//      `run_attempts_exhausted` at the pinned `max_attempts`).
// The attempt is minted with the sealed attempt's engine identity and
// provenance, and `forked_from_run_seq` records the branch point. No recorder
// in this revision seals a ledger attempt at `fork` (`gradeSealedAttempt`
// grades at the `harness` tier), so the mint waits for the gateway-observed
// ledger lane; its unit test drives a fabricated `fork` seal.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { runFork, type RunForkOutput } from "@oxagen/oxagen/contracts/run.fork";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { AttemptRecord, RunStore } from "@oxagen/run-ledger";
import { isRunNotWritableError } from "@oxagen/run-ledger/run-errors";
import {
  gradeAllows,
  isContentBearingFrame,
  isReplayGrade,
} from "@oxagen/tacho";
import {
  defaultRunReadDeps,
  ledgerStore,
  readFrames,
  resolveRun,
  type RunReadDeps,
} from "./lib/run-read";

const FORK_ROLES = ["Owner", "Admin", "Member"] as const;

/** Frames checked per page while walking up to the branch point. */
const PAGE = 500;

export type RunForkDeps = RunReadDeps & {
  attempts: Pick<RunStore, "listRunAttempts" | "createAttempt">;
};

const conflict = (reason: string) =>
  new HandlerError({ code: "conflict", reason });

/** The most recently sealed attempt, or null while none has sealed. */
function latestSealedAttempt(
  attempts: readonly AttemptRecord[],
): AttemptRecord | null {
  let latest: AttemptRecord | null = null;
  for (const attempt of attempts) {
    if (!attempt.seal) continue;
    if (!latest || attempt.seal.sealedAt > (latest.seal?.sealedAt ?? 0)) {
      latest = attempt;
    }
  }
  return latest;
}

export function createRunForkHandler(
  deps: RunForkDeps,
): CapabilityHandler<typeof runFork> {
  return async (input, ctx): Promise<RunForkOutput> => {
    await assertOrgRole(
      { ...ctx, userId: await resolveActingUserId(ctx) },
      { org: FORK_ROLES },
    );
    const run = await resolveRun(deps, ctx, input.runId);
    if (run.source !== "ledger") throw conflict("fork_requires_ledger_run");

    const sealed = latestSealedAttempt(
      await deps.attempts.listRunAttempts(run.runId),
    );
    const seal = sealed?.seal ?? null;
    if (!sealed || !seal) throw conflict("run_not_sealed");
    const grade = isReplayGrade(seal.replayGrade) ? seal.replayGrade : null;
    if (!gradeAllows(grade, "fork")) throw conflict("replay_grade_below_fork");

    const fromSeq = BigInt(input.fromSeq);
    if (seal.finalRunSeq === null || fromSeq > BigInt(seal.finalRunSeq)) {
      throw conflict("from_seq_past_seal");
    }

    // Walk the recording up to the branch point under the seal's rule
    // (`deriveCompletenessGaps`): a content-bearing frame, or any frame whose
    // digest was recorded, must have its body, or the cassette has a hole
    // before the fork.
    let after = "0";
    for (;;) {
      const page = await readFrames(deps, run, after, PAGE);
      for (const frame of page) {
        if (BigInt(frame.seq) > fromSeq) break;
        const carriesContent =
          isContentBearingFrame(frame.type) || frame.body.bodyDigest !== null;
        if (carriesContent && frame.body.bodyRef === null) {
          throw conflict("gap_before_from_seq");
        }
      }
      const last = page.at(-1);
      if (!last || page.length < PAGE || BigInt(last.seq) >= fromSeq) break;
      after = last.seq;
    }

    const created = await deps.attempts
      .createAttempt({
        runId: run.runId,
        producerId: sealed.producerId,
        engine: sealed.engine,
        resumedFrom: {
          attemptId: sealed.attemptId,
          attemptPublicId: sealed.attemptPublicId,
        },
        forkedFromRunSeq: input.fromSeq,
      })
      .catch((err: unknown) => {
        // A cancel or a pause can win the run lock after the reads above, and
        // a run can reach its attempt ceiling. Each is the caller's conflict.
        if (!isRunNotWritableError(err)) throw err;
        throw conflict(
          err.reason === "attempts_exhausted"
            ? "run_attempts_exhausted"
            : "run_not_writable",
        );
      });
    return {
      attemptId: created.attemptPublicId,
      attemptNumber: created.attemptNumber,
    };
  };
}

function defaultRunForkDeps(): RunForkDeps {
  const ledger = ledgerStore();
  return {
    ...defaultRunReadDeps(),
    attempts: {
      listRunAttempts: (runId) => ledger.listRunAttempts(runId),
      createAttempt: (input) => ledger.createAttempt(input),
    },
  };
}

export const runForkHandler = createRunForkHandler(defaultRunForkDeps());
