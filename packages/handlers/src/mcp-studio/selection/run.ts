// run.ts: run_studio_selection (mcp-studio-spec, Try it and tests; lane M16).
//
// A person asks Studio to run one server's selection tests. The handler:
//
//   1. Builds the folder the way list_studio_findings does: the saved draft,
//      or the production folder when there is no draft. The run offers each
//      imported tool's definition from that build, so a description a person
//      edited in the draft is the one the model reads.
//   2. Reads tests/selection.jsonl from the production branch, at the commit
//      the build read. Review does not write that file, so a draft has none.
//   3. Asks the workspace's model about each task, SELECTION_CONCURRENCY at
//      once, and reports each hit and miss. runSelection refuses more than
//      SELECTION_TASKS_MAX tasks before the model resolves, so an over-cap
//      file spends nothing.
//   4. Stops at SELECTION_RUN_DEADLINE_MS. It starts no new task, cuts off the
//      calls still out, and returns the tasks that finished, with the rest
//      marked not_run and stoppedAtDeadline set (#5171). A person sees each
//      answer that came back before the deadline.
//
// Only a person starts a run. No schedule, compile check, or webhook calls
// this handler, because every task is a billed model call. It writes nothing
// to the steering repo or the draft store.
import { TooManyToolsForProviderError } from "@oxagen/agent/runtime/tool-budget";
import {
  parseSelectionTests,
  runSelection,
  SELECTION_TESTS_FILE,
  SelectionRunError,
  selectionTools,
  type SelectionCase,
  type SelectionReport,
} from "@oxagen/mcp-studio";
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import {
  toolStudioSelectionRun,
  type ToolStudioSelectionRunOutput,
} from "@oxagen/oxagen/contracts/tool.studio.selection.run";
import { serverFolderPath } from "@oxagen/oxagen/steering-repo/paths";
import type { SteeringRepository } from "../../context.steering.github";
import { toolsSteeringHost } from "../../tools.pr.open";
import { authorizeStudio, describeIssues } from "../import/checks";
import { buildStudioFolderView, type ListStudioFindingsDeps } from "../import/findings.list";
import { workspaceCredentials } from "../import/review.open";
import { importSource } from "../import/source";
import { postgresStudioDraftStore } from "../import/store";
import { workspaceSelectionModel, type StudioSelectionModel, type StudioSelectionModelDeps } from "./model";

/**
 * The longest one run may take. The load balancer and the proxy in front of
 * the API and MCP servers close a request after 300 seconds, so a run stops
 * well before that and returns what it finished, instead of ending in a
 * gateway timeout.
 */
export const SELECTION_RUN_DEADLINE_MS = 240_000;

export interface RunStudioSelectionDeps extends ListStudioFindingsDeps {
  /** The model the run asks, on the organization's route, with the telemetry each request writes. */
  model: (orgId: string, telemetry: StudioSelectionModelDeps["telemetry"]) => StudioSelectionModel;
  /** The signal that stops the run and returns what finished: SELECTION_RUN_DEADLINE_MS from now in production. */
  deadline: () => AbortSignal;
}

/** The tasks in tests/selection.jsonl on the production branch, at the commit the folder was read at. */
async function readSelectionTests(
  host: Pick<ReturnType<ListStudioFindingsDeps["host"]>, "readFile">,
  repo: SteeringRepository,
  at: string,
  server: string,
): Promise<SelectionCase[]> {
  const path = `${serverFolderPath(server)}/${SELECTION_TESTS_FILE}`;
  const text = await host.readFile(repo, path, at);
  if (text === null) {
    throw new HandlerError({
      code: "not_found",
      reason: "selection_tests_missing",
      message: `${repo.fullName} has no ${path} on ${repo.defaultBranch}, so the run has no tasks. Add the file with one task and its expected tool per line, merge it, then run the selection tests again.`,
    });
  }
  const read = parseSelectionTests(text);
  if (!read.ok) {
    throw new HandlerError({
      code: "conflict",
      reason: "selection_tests_invalid",
      message: `${path} on ${repo.defaultBranch} does not parse. ${describeIssues(read.issues)} Correct the file, merge it, then run the selection tests again.`,
    });
  }
  return read.value;
}

/**
 * The refusal a person reads for a run that failed, or the error itself when
 * it is an outage. The deadline is not a failure: runSelection returns the
 * tasks that finished.
 */
function failed(error: unknown, server: string): unknown {
  if (!(error instanceof SelectionRunError)) return error;
  if (error.code !== "model_failed") {
    return new HandlerError({ code: "conflict", reason: error.code, message: error.message });
  }
  const cause = error.cause;
  if (cause instanceof TooManyToolsForProviderError) {
    return new HandlerError({
      code: "conflict",
      reason: cause.code,
      message: `${server} offers ${cause.toolCount} tools, and ${cause.modelId} takes at most ${cause.maxTools} in one request (${cause.source}). The run asked the model nothing. An agent on this model could not see every tool at once either. Import fewer tools, or move the workspace to a model without this limit.`,
    });
  }
  // A failed model call passes its own error through, as Draft's does.
  return cause;
}

export function createRunStudioSelectionHandler(
  deps: RunStudioSelectionDeps,
): CapabilityHandler<typeof toolStudioSelectionRun> {
  return async (input, ctx): Promise<ToolStudioSelectionRunOutput> => {
    await deps.authorize(toolStudioSelectionRun, ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const { folder, draft, repo, productionSha } = await buildStudioFolderView(deps, scope, input.server);
    const tests = await readSelectionTests(deps.host(), repo, productionSha, folder.server);

    const model = deps.model(ctx.orgId, {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      surface: ctx.surface,
      // Null outside a chat turn. A request id is not a message id.
      messageId: ctx.messageId,
    });
    let report: SelectionReport;
    try {
      report = await runSelection(selectionTools(folder.compiled), tests, model, deps.deadline());
    } catch (error) {
      throw failed(error, folder.server);
    }
    return {
      server: folder.server,
      basis: draft === null ? "published" : "draft",
      revision: draft?.revision ?? null,
      model: model.modelId(),
      counts: report.counts,
      cases: report.cases,
      stoppedAtDeadline: report.stopped,
    };
  };
}

export const runStudioSelectionHandler = createRunStudioSelectionHandler({
  store: postgresStudioDraftStore(),
  authorize: authorizeStudio,
  host: toolsSteeringHost,
  credentials: workspaceCredentials,
  importSource: (source) => importSource(source),
  model: workspaceSelectionModel,
  deadline: () => AbortSignal.timeout(SELECTION_RUN_DEADLINE_MS),
});
