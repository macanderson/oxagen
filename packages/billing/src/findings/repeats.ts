/**
 * Repeated shell commands and duplicate tool calls (detector 1, ADR-208). A
 * model request counts when every tool call it made repeats an earlier call
 * of the run with the same input and the same result. Its whole priced cost
 * counts once, against nothing: the request did no work the run needed. A
 * request that also made one new call is not counted.
 *
 * A request of shell repeats alone is a repeated shell command, cited at the
 * Bash tool. Any other is a duplicate tool call, cited at the run's agent, or
 * its operator when it names no agent. Both claim the request's frame as
 * detector 1, after spin loops and retry loops. A run whose frames were not
 * read has each repeat cited, and nothing prices it.
 *
 * The evidence counts every call a counted request made, so the Spend card's
 * `calls` figure counts calls, as its label says (#4506). The price stays per
 * request.
 *
 * The repeat rule is the rollup's (../step-grade.ts, ADR-199), so a request
 * this job counts is one whose steps the run's productive ratio counts as not
 * advancing it.
 */
import { SHELL_TOOL } from "../step-grade";
import type { RunTotalsRecord } from "../cost-rollup";
import {
  claimKey,
  onlyRepeats,
  type RunRequest,
  type RunView,
  type ViewCall,
} from "./requests";
import {
  agentOrOperator,
  plural,
  requestMeasure,
  type ClaimOf,
  type DetectContext,
  type Detector,
  type DetectInput,
  type FindingKey,
  type Measure,
} from "./shared";

function repeatKey(
  calls: readonly ViewCall[],
  run: RunTotalsRecord,
): FindingKey | null {
  if (calls.every((c) => c.repeat === "shell"))
    return {
      kind: "repeated_shell_commands",
      level: "tool",
      subject: SHELL_TOOL,
    };
  return agentOrOperator("duplicate_tool_calls", run);
}

/**
 * Add one counted request to its finding as one cited item per call it made
 * (#4506). The request's whole price and its claim ride the first call. Each
 * other call adds nothing to the price, on the same basis, so a priced
 * request covers every call it made and an unpriced one covers none.
 */
function addRequest(
  key: FindingKey,
  input: DetectInput,
  run: RunTotalsRecord,
  request: RunRequest,
  claim: ClaimOf | null,
  ctx: DetectContext,
): void {
  const [first, ...rest] = request.calls;
  if (first === undefined) return;
  const measure = requestMeasure(request.frame);
  ctx.groups.add(
    key,
    input.toolWindowStart,
    run,
    measure,
    [first.frame],
    claim,
  );
  const nothing: Measure = {
    measuredTokens: 0,
    counterfactualTokens: 0,
    micros:
      measure.micros === null ? null : { measured: 0n, counterfactual: 0n },
    ...(measure.basis === undefined ? {} : { basis: measure.basis }),
  };
  for (const c of rest)
    ctx.groups.add(key, input.toolWindowStart, run, nothing, [c.frame]);
}

function detectRun(
  view: RunView,
  input: DetectInput,
  ctx: DetectContext,
): void {
  const run = view.run;
  if (view.requests === null) {
    for (const c of view.calls) {
      if (c.repeat === null || ctx.taken.has(c.call)) continue;
      const key = repeatKey([c], run);
      if (key === null) continue;
      ctx.taken.add(c.call);
      if (ctx.groups.admits(key, run))
        ctx.groups.add(key, input.toolWindowStart, run, requestMeasure(null), [
          c.frame,
        ]);
    }
    return;
  }
  for (const request of view.requests) {
    if (
      !onlyRepeats(request) ||
      request.calls.some((c) => ctx.taken.has(c.call))
    )
      continue;
    const key = repeatKey(request.calls, run);
    if (key === null) continue;
    if (request.frame !== null) {
      const claim = claimKey(run.runId, request.frame.key);
      if (ctx.claimed.has(claim)) continue;
      ctx.claimed.add(claim);
    }
    for (const c of request.calls) ctx.taken.add(c.call);
    if (!ctx.groups.admits(key, run)) continue;
    addRequest(
      key,
      input,
      run,
      request,
      request.frame === null ? null : { detector: 1, frame: request.frame },
      ctx,
    );
  }
}

export const repeats: Detector = {
  kinds: ["repeated_shell_commands", "duplicate_tool_calls"],
  counting: 1,
  detect(input, ctx) {
    for (const view of ctx.views) detectRun(view, input, ctx);
  },
  prose: (group, evidence) => {
    const one = evidence.calls === 1;
    const calls = plural(evidence.calls, "call", "calls");
    const runs = plural(group.runs.size, "run", "runs");
    const turn = `${one ? "It" : "Each"} came from a turn that made no other call.`;
    return group.kind === "repeated_shell_commands"
      ? {
          why: `${calls} on ${runs} re-ran ${one ? "a shell command" : "shell commands"} whose identical input had already returned the identical output earlier in the run. ${turn}`,
          fix: "Serve an identical command from the run's earlier result until a write changes what it reads.",
        }
      : {
          why: `${calls} on ${runs} repeated ${one ? "a tool call" : "tool calls"} with an identical input and output digest earlier in the same run. ${turn}`,
          fix: "Tell the agent not to re-read a result it already holds in the run.",
        };
  },
};
