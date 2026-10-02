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
 * The repeat rule is the rollup's (../step-grade.ts, ADR-199), so a request
 * this job counts is one whose steps the run's productive ratio counts as not
 * advancing it.
 */
import { SHELL_TOOL } from "../step-grade";
import type { RunTotalsRecord } from "../cost-rollup";
import {
  claimKey,
  onlyRepeats,
  type RunView,
  type ViewCall,
} from "./requests";
import {
  agentOrOperator,
  plural,
  requestMeasure,
  type DetectContext,
  type Detector,
  type DetectInput,
  type FindingKey,
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
    ctx.groups.add(
      key,
      input.toolWindowStart,
      run,
      requestMeasure(request.frame),
      request.calls.map((c) => c.frame),
      request.frame === null ? null : { detector: 1, frame: request.frame },
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
    const turns = plural(evidence.calls, "turn", "turns");
    const runs = plural(group.runs.size, "run", "runs");
    return group.kind === "repeated_shell_commands"
      ? {
          why: `${turns} on ${runs} only re-ran shell commands whose identical input had already returned the identical output earlier in the run.`,
          fix: "Serve an identical command from the run's earlier result until a write changes what it reads.",
        }
      : {
          why: `${turns} on ${runs} only repeated tool calls with an identical input and output digest earlier in the same run.`,
          fix: "Tell the agent not to re-read a result it already holds in the run.",
        };
  },
};
