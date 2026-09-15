// `fork_run`: a new attempt that replays the recording up to a frame
// (Mission Control spec §8.4 `fork`; ADR-058 decision 3).
//
// Guards, in order, each with its negative test:
//   1. Role: org Owner, Admin or Member (`assertOrgRole`, ARCHITECTURE.md
//      §3.2); the kernel's IAM check allows everything for a non-enterprise
//      org, so the handler is where a Viewer is refused.
//   2. The run is a ledger run in the caller's workspace (`not_found`).
//   3. The run has a sealed attempt whose recorded grade allows `fork`
//      (`conflict`, `replay_grade_below_fork`). The grade is read, never
//      recomputed: the seal is the record.
//   4. The branch point lies within the sealed recording (`conflict`,
//      `from_seq_past_seal`).
//   5. Every frame up to the branch point that carried content kept its body
//      (`conflict`, `gap_before_from_seq`): the cassette would otherwise have
//      a hole before the fork.
// The attempt is minted with the sealed attempt's engine identity and
// provenance, and `forked_from_run_seq` records the branch point.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { runFork, type RunForkOutput } from "@oxagen/oxagen/contracts/run.fork";
import { assertOrgRole } from "@oxagen/iam/org-role";
import type { AttemptRecord, RunStore } from "@oxagen/run-ledger";
import { gradeAllows, isReplayGrade } from "@oxagen/tacho";
import { runScope } from "./run.list";
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
    await assertOrgRole(ctx, { org: FORK_ROLES });
    const scope = runScope(ctx);
    const run = await resolveRun(deps, scope, input.runId);
    if (run.source !== "ledger") {
      throw new HandlerError({ code: "not_found", reason: "run_not_found" });
    }

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

    // Walk the recording up to the branch point: every frame with content
    // must have its body, or the cassette has a hole before the fork.
    let after = "0";
    for (;;) {
      const page = await readFrames(deps, run, after, PAGE);
      for (const frame of page) {
        if (BigInt(frame.seq) > fromSeq) break;
        if (frame.body.bodyDigest !== null && frame.body.bodyRef === null) {
          throw conflict("gap_before_from_seq");
        }
      }
      const last = page.at(-1);
      if (!last || page.length < PAGE || BigInt(last.seq) >= fromSeq) break;
      after = last.seq;
    }

    const created = await deps.attempts.createAttempt({
      runId: run.runId,
      producerId: sealed.producerId,
      engine: sealed.engine,
      resumedFrom: {
        attemptId: sealed.attemptId,
        attemptPublicId: sealed.attemptPublicId,
      },
      forkedFromRunSeq: input.fromSeq,
    });
    return {
      attemptId: created.attemptPublicId,
      attemptNumber: created.attemptNumber,
    };
  };
}

export function defaultRunForkDeps(): RunForkDeps {
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
