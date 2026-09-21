// `get_run_outputs`: the Run page's spine — what one run produced, in the
// order it produced it (ADR-058; run mockup `<RunOutputs>`, Option Story).
//
// The two stores answer the one node shape:
//
//   tse_…  a wrapped session, read from `tacho.session_files`: one row per
//          path the session touched, already carrying its counters, its diff
//          stat, git's word for what happened to it, and the frames that
//          touched it. The row names a path, so the node names a file.
//   arun_… an evidence-ledger run, read from its `change.recorded` and
//          `provider_publish.*` receipts. Those carry a payload, and a
//          `RunFrame` does not, so they are read through the store's own
//          event reader rather than through `readFrames`.
//
// Both are scoped through `resolveRun`, which is where a run outside the
// caller's workspace becomes `not_found`; every Postgres read then goes
// through `withTenantDb` and also names org_id and workspace_id, because a
// local stack runs with the RLS bypass on.
//
// Governed gates come last and carry no frame sequence: `approval_requests`
// records none, and the end of the spine is where a gate stopped the run —
// nothing after it happened.
//
// Nothing here fills a gap with a substitute: a record that says nothing
// answers null, and a read cut at its cap says `complete: false` rather than
// presenting a prefix as the whole.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  RUN_OUTPUT_NODE_MAX,
  type RunOutputNode,
  runOutputsGet,
  type RunOutputsGetOutput,
} from "@oxagen/oxagen/contracts/run.outputs.get";
import {
  gateNodes,
  ledgerNode,
  postgresRunOutputQueries,
  type RunOutputQueries,
  sessionFileNode,
  tally,
} from "./lib/run-outputs";
import { runScope } from "./run.list";
import {
  defaultRunReadDeps,
  resolveRun,
  type ResolvedRun,
  type RunReadDeps,
} from "./lib/run-read";

/**
 * The most ledger events one read walks. Receipts are sparse in a run's
 * frames, so the walk is bounded by events and not by nodes; the node cap
 * stops it earlier whenever the run is productive.
 */
const LEDGER_EVENT_CAP = 10_000;
/** Events per page of that walk. */
const LEDGER_PAGE = 500;
/** The most gates one spine shows. */
const GATE_MAX = 50;

export type RunOutputsGetDeps = RunReadDeps & { outputs: RunOutputQueries };

/** A wrapped session's paths, in the order the frames touched them. */
async function wrappedNodes(
  deps: RunOutputsGetDeps,
  scope: ReturnType<typeof runScope>,
  sessionUuid: string,
): Promise<{ nodes: RunOutputNode[]; complete: boolean }> {
  // One over the cap, so a full page is told apart from a cut read.
  const rows = await deps.outputs.sessionFiles(
    scope,
    sessionUuid,
    RUN_OUTPUT_NODE_MAX + 1,
  );
  const complete = rows.length <= RUN_OUTPUT_NODE_MAX;
  return {
    nodes: rows.slice(0, RUN_OUTPUT_NODE_MAX).map(sessionFileNode),
    complete,
  };
}

/** A ledger run's receipts, walked page by page from its first frame. */
async function ledgerNodes(
  deps: RunOutputsGetDeps,
  runId: string,
): Promise<{ nodes: RunOutputNode[]; complete: boolean }> {
  const nodes: RunOutputNode[] = [];
  let after = "0";
  let walked = 0;
  for (;;) {
    const want = Math.min(LEDGER_PAGE, LEDGER_EVENT_CAP - walked);
    if (want <= 0) return { nodes, complete: false };
    const page = await deps.store.readAttemptEventsSince(runId, after, want);
    walked += page.length;
    for (const event of page) {
      const node = ledgerNode(event);
      if (node === null) continue;
      nodes.push(node);
      // The spine is full: everything after it is unread, so say so.
      if (nodes.length >= RUN_OUTPUT_NODE_MAX) {
        return { nodes, complete: false };
      }
    }
    const last = page.at(-1);
    if (!last || page.length < want) return { nodes, complete: true };
    after = last.runSeq;
  }
}

export function createRunOutputsGetHandler(
  deps: RunOutputsGetDeps,
): CapabilityHandler<typeof runOutputsGet> {
  return async (input, ctx): Promise<RunOutputsGetOutput> => {
    const scope = runScope(ctx);
    const run: ResolvedRun = await resolveRun(deps, ctx, input.runId);

    const produced =
      run.source === "tacho"
        ? await wrappedNodes(deps, scope, run.sessionUuid)
        : await ledgerNodes(deps, run.runId);

    // Gates are read for either store: the approval record is the kernel's,
    // and it names the run by its public id whichever store minted it.
    const gateRows = await deps.outputs.runApprovals(
      scope,
      input.runId,
      GATE_MAX + 1,
    );
    const gatesComplete = gateRows.length <= GATE_MAX;
    const gates = gateRows.slice(0, GATE_MAX).flatMap(gateNodes);

    const nodes = [...produced.nodes, ...gates];
    return {
      runId: input.runId,
      source: run.source === "tacho" ? "wrapped" : "ledger",
      nodes,
      tally: tally(nodes),
      complete: produced.complete && gatesComplete,
    };
  };
}

export const runOutputsGetHandler = createRunOutputsGetHandler({
  ...defaultRunReadDeps(),
  outputs: postgresRunOutputQueries,
});
