// `summarize_run`: queue the generated name and summary of a sealed run
// (Mission Control mockup 2821-2835; G14; ADR-058).
//
// Guards, each with its negative test: org Owner, Admin or Member
// (`assertOrgRole`, ARCHITECTURE.md §3.2), for the signed-in user or the
// creator of the API key (`resolveActingUserId`), who is recorded as the
// requester; the run is in the caller's
// workspace (`not_found`); the workspace has run enrichment on (`conflict`,
// `enrichment_disabled`), since the job writes no summary for a workspace
// that turned it off and a `queued` answer would promise one that never
// comes; the run is sealed (`conflict`, `run_not_sealed`); the recording kept
// bodies (`conflict`, `digest_only`): a summary written from receipts alone
// would be the placeholder the interface forbids. The model call itself runs
// in the durable function `run.enrich` (@oxagen/inngest-functions), which
// the `run/enrich` event starts. It makes no model call when none of the
// run's bodies was retained, and writes the name and the summary together.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import {
  runSummarize,
  type RunSummarizeOutput,
} from "@oxagen/oxagen/contracts/run.summarize";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { eventClient } from "./event-client";
import { canSummarizeRun } from "@oxagen/oxagen/contracts/run.list";
import { recordedGaps, runScope } from "./run.list";
import {
  defaultRunReadDeps,
  resolveRun,
  type ResolvedRun,
  type RunReadDeps,
} from "./lib/run-read";

const SUMMARIZE_ROLES = ["Owner", "Admin", "Member"] as const;

export const RUN_SUMMARIZE_EVENT = "run/enrich";

interface RunSummarizeEvent {
  name: typeof RUN_SUMMARIZE_EVENT;
  data: {
    orgId: string;
    workspaceId: string;
    runPublicId: string;
    requestedByUserId: string;
  };
}

export type RunSummarizeDeps = RunReadDeps & {
  dispatch: (event: RunSummarizeEvent) => Promise<void>;
};

/** The gaps the run's seal recorded: the latest ledger seal's, or the session's. */
function sealedGaps(run: ResolvedRun): string[] {
  return run.source === "ledger"
    ? recordedGaps(run.record.seal?.completenessGaps)
    : recordedGaps(run.row.session.completenessGaps);
}

/**
 * The refusal a run earns, or null. It is `canSummarizeRun`'s rule spelled out:
 * that predicate answers whether the action is offered and this answers why it
 * is not, and both read the same two facts. A row that says `canSummarize` and
 * a handler that refuses would be the guaranteed conflict #3285 records.
 */
function summarizeRefusal(run: ResolvedRun): string | null {
  const gaps = sealedGaps(run);
  if (canSummarizeRun({ status: run.item.status, completenessGaps: gaps })) {
    return null;
  }
  return run.item.status === "live" ? "run_not_sealed" : "digest_only";
}

export function createRunSummarizeHandler(
  deps: RunSummarizeDeps,
): CapabilityHandler<typeof runSummarize> {
  return async (input, ctx): Promise<RunSummarizeOutput> => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: SUMMARIZE_ROLES },
    );
    const scope = runScope(ctx);
    const run = await resolveRun(deps, ctx, input.runId);
    // `resolveRun` read the workspace setting. The job checks it again and
    // writes no summary when it is off, so the request is refused here.
    if (run.item.enrichmentEnabled === false) {
      throw new HandlerError({
        code: "conflict",
        reason: "enrichment_disabled",
      });
    }
    const refusal = summarizeRefusal(run);
    if (refusal !== null) {
      throw new HandlerError({ code: "conflict", reason: refusal });
    }
    await deps.dispatch({
      name: RUN_SUMMARIZE_EVENT,
      data: {
        ...scope,
        runPublicId: input.runId,
        // assertOrgRole refused a call with no acting user above.
        requestedByUserId: actingUserId as string,
      },
    });
    return { runId: input.runId, status: "queued" };
  };
}

export const runSummarizeHandler = createRunSummarizeHandler({
  ...defaultRunReadDeps(),
  dispatch: (event) => eventClient.send(event),
});
