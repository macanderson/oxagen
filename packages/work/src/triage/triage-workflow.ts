// triage-workflow.ts: the workflow a triaged item runs.
//
// The model names a workflow slug, but it does not see the workspace's
// workflow files: TriageInput carries none. So the caller checks the slug
// against the files after triageItem returns. A workflow whose [match] fits the
// item wins. Without a match, the model's slug stands when a file has that
// slug. Otherwise the decision turns to needs_info with a question for the
// people in the workspace, because an item with no workflow cannot run.
import type { TriageDecision, Workflow } from "../types";
import type { TriageWorkItem } from "./triage-item";

/** One workflow file. The slug is its file name without `.toml`. */
export interface TriageWorkflowFile {
  slug: string;
  workflow: Pick<Workflow, "match" | "stage">;
}

/** The question triage adds when no workflow fits a triaged item. */
export const NO_WORKFLOW_QUESTION =
  "No workflow in work/workflows/ fits this item. Which workflow should run it, or which workflow should list its labels or collector under [match]?";

/**
 * The first workflow, in slug order, whose [match] fits. A [match] with no keys
 * fits nothing. Each key it sets must fit: labels share one label with the
 * item, and collectors name the item's collector.
 */
export function matchTriageWorkflow(
  files: readonly TriageWorkflowFile[],
  item: { labels: readonly string[]; collector: string },
): TriageWorkflowFile | null {
  const labels = new Set(item.labels);
  const sorted = [...files].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const file of sorted) {
    const match = file.workflow.match;
    if (match === undefined || (match.labels === undefined && match.collectors === undefined)) continue;
    if (match.labels !== undefined && !match.labels.some((label) => labels.has(label))) continue;
    if (match.collectors !== undefined && !match.collectors.includes(item.collector)) continue;
    return file;
  }
  return null;
}

/** The decision with its workflow checked against the workspace's workflow files. */
export function applyTriageWorkflowMatch(
  decision: TriageDecision,
  item: Pick<TriageWorkItem, "labels" | "collector">,
  files: readonly TriageWorkflowFile[],
): TriageDecision {
  if (decision.state !== "triaged") return decision;
  const match = matchTriageWorkflow(files, { labels: [...item.labels, ...decision.labels], collector: item.collector });
  if (match !== null) return { ...decision, workflow: match.slug };
  if (files.some((file) => file.slug === decision.workflow)) return decision;
  return {
    ...decision,
    state: "needs_info",
    workflow: null,
    questions: [...decision.questions, NO_WORKFLOW_QUESTION],
  };
}
