/**
 * The plan tool — pipeline step 3 (Group 6).
 *
 * When work is complex or multi-step (complexity >= `pipeline.plan.minComplexity`),
 * the coordinator breaks it into a logical task list it then manages: a task is
 * marked complete only after step-4 evidence is collected (when `verifyWork` is
 * on) and the step-5 judge passes it. This tool produces that list.
 *
 * The decomposition is deterministic and context-scoped: it seeds one
 * implementation task per impacted file the graph surfaced (so the plan tracks
 * the real blast radius), then always appends a verify task and a judge task that
 * depend on the implementation — encoding the definition-of-done order in the
 * graph of tasks itself. It never calls a model; planning here is structural, not
 * generative. Matches `plan-tool.json`.
 */
import { defaultPipelineLogSink, type PipelineLogSink } from "./pipeline-logging.js";

/** One planned task. */
export interface PlanTask {
  id: string;
  title: string;
  dependsOn?: string[];
}

/** Input to the plan tool. Matches `plan-tool.json -> tools[0].input`. */
export interface PlanInput {
  objective: string;
  enhancedPrompt?: string;
  /** Structured file list from `graph_query`, used to scope tasks. */
  graphImpactedFiles?: string[];
}

/** Output of the plan tool. */
export interface PlanOutput {
  tasks: PlanTask[];
}

/** Slugify a path into a stable task-id fragment. */
function idFragment(path: string, index: number): string {
  const base = path.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return base ? `${base}-${index}` : `impl-${index}`;
}

/**
 * Break an objective into a managed task list. When the graph surfaced impacted
 * files, one implementation task is created per file; otherwise a single
 * implementation task stands in. A verify task and a judge task always close the
 * list and depend on every implementation task, so completion order follows the
 * definition of done.
 */
export async function runPlan(
  input: PlanInput,
  log: PipelineLogSink = defaultPipelineLogSink,
): Promise<PlanOutput> {
  log({
    kind: "step",
    step: 3,
    label: "tool=plan",
    status: "start",
    fields: [["objective", input.objective]],
  });

  const files = input.graphImpactedFiles ?? [];
  const implTasks: PlanTask[] =
    files.length > 0
      ? files.map((path, i) => ({ id: idFragment(path, i + 1), title: `Update ${path}` }))
      : [{ id: "impl-1", title: input.objective }];

  const implIds = implTasks.map((t) => t.id);
  const verify: PlanTask = {
    id: "verify",
    title: "Collect evidence of done (tests, build, screenshots)",
    dependsOn: implIds,
  };
  const judge: PlanTask = {
    id: "judge",
    title: "Judge the work on a different model and pass the quality gate",
    dependsOn: ["verify"],
  };

  const tasks = [...implTasks, verify, judge];
  log({ kind: "step", step: 3, label: "tool=plan", status: "done", fields: [["tasks", tasks.length]] });
  return { tasks };
}
