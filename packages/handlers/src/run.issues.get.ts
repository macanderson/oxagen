// get_run_issues — the issues one run worked on (#3970, ADR-197).
//
// Three sources name an issue, and nothing else does:
//
// - `task`: the run's own task reference, `stated`.
// - `resolves`: an issue a pull request the run recorded opening closes, as
//   GitHub records the closing reference, `observed`. A wrapped run's
//   receipts are its `oxagen:pr_link` frames and a ledger run's are its
//   `provider_publish.pull_request_opened` events. A pull request matched by
//   branch or head commit adds nothing, because it does not show the run
//   opened it.
// - `referenced`: an issue a command or GitHub MCP frame names, `observed`
//   (`lib/run-command-refs.ts`).
//
// One row per issue: a task that frames also name keeps its stated edge and
// carries those frames, and a closing issue a frame also names stays
// `resolves`. Each row's title and state are GitHub's, read on load
// (`lib/run-issues-tracker.ts`), and a state that was not read stays null with
// the reason in `statusRead`.
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  RUN_ISSUE_MAX,
  runIssuesGet,
  type RunIssue,
  type RunIssuesGetOutput,
} from "@oxagen/oxagen/contracts/run.issues.get";
import type {
  RunCheckout,
  RunRepository,
} from "@oxagen/oxagen/contracts/run.work.get";
import {
  COMMAND_REF_FRAME_CAP,
  issueOfUrl,
  issueRefsOfFrame,
  type NamedRepository,
  readRunCommandRefFrames,
  resolveFrameRepository,
} from "./lib/run-command-refs";
import {
  type ClosingPullRequest,
  readClosingIssues,
  readIssueStates,
  type IssueState,
  type IssueStateRequest,
} from "./lib/run-issues-tracker";
import {
  defaultRunReadDeps,
  resolveRun,
  type RunReadDeps,
} from "./lib/run-read";
import {
  checkoutOf,
  connectedRunRepositories,
  type ConnectedRunRepository,
  prLinkOf,
  readWorkContexts,
  readWorkPrLinks,
  WORK_CONTEXT_CAP,
  WORK_PR_LINK_CAP,
} from "./lib/run-work";
import { readLedgerPrReceipts } from "./lib/run-work-prs";
import { runScope } from "./run.list";

export type RunIssuesDeps = RunReadDeps & {
  contexts: typeof readWorkContexts;
  prLinks: typeof readWorkPrLinks;
  commandFrames: typeof readRunCommandRefFrames;
  repositories: typeof connectedRunRepositories;
  closingIssues: typeof readClosingIssues;
  tracker: typeof readIssueStates;
};

/** The most frames and closing pull requests one row carries (the contract's bound). */
const ROW_REF_MAX = 20;

/**
 * The warnings that mean an issue may be missing from the list, so the count
 * is a floor. A state the tracker did not read, or a pull request number a
 * frame named, leaves the list whole.
 */
const LIST_CUTTING = new Set([
  "closing_issue_limit",
  "closing_issues_read_failed",
  "recorded_repository_not_connected",
  "issue_frame_limit",
  "ledger_event_limit",
  "chain_break",
]);

type Relation = RunIssue["relation"];
const RELATION_RANK: Record<Relation, number> = {
  task: 0,
  resolves: 1,
  referenced: 2,
};

/** A row while the sources are merged, before the tracker read fills it. */
interface Draft {
  key: string;
  ref: string;
  repository: RunRepository | null;
  number: number | null;
  relation: Relation;
  /** Why the state cannot be read, decided before any read. */
  unreadable: "not_github" | "repository_unknown" | null;
  resolvedBy: Map<number, string>;
  actions: RunIssue["actions"];
  frameSeqs: Set<string>;
  url: string | null;
  /** A state GitHub already gave with the closing list. */
  closingState: { title: string; state: "open" | "closed" } | null;
}

function keyOf(repository: NamedRepository | null, number: number): string {
  return repository === null
    ? `#${String(number)}`
    : `${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}#${String(number)}`;
}

function refOf(repository: NamedRepository | null, number: number): string {
  return repository === null
    ? `#${String(number)}`
    : `${repository.owner}/${repository.name}#${String(number)}`;
}

/** The issue page a GitHub repository and number name, derived from the record. */
function issuePage(
  repository: RunRepository | null,
  number: number | null,
): string | null {
  if (repository === null || number === null) return null;
  if (repository.host !== "github.com") return null;
  return `${repository.url}/issues/${String(number)}`;
}

/**
 * The run's task reference as a row: `owner/repo#N` or a GitHub issue URL
 * names a GitHub issue, `#N` a number whose repository is resolved like a
 * frame's, and anything else (`ENG-4121`, a free-text goal) is a tracker key
 * Oxagen does not read.
 */
function taskDraft(
  taskRef: string,
  checkouts: readonly RunCheckout[],
  repositories: readonly ConnectedRunRepository[],
): Draft {
  const base = {
    relation: "task" as const,
    resolvedBy: new Map<number, string>(),
    actions: [],
    frameSeqs: new Set<string>(),
    closingState: null,
  };
  const spelled = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(taskRef);
  const fromUrl = issueOfUrl(taskRef);
  const bare = /^#(\d+)$/.exec(taskRef);
  const named: NamedRepository | null = spelled
    ? { owner: spelled[1] ?? "", name: spelled[2] ?? "" }
    : (fromUrl?.repository ?? null);
  const number = Number(spelled?.[3] ?? fromUrl?.number ?? bare?.[1] ?? NaN);
  if ((named === null && bare === null) || !Number.isSafeInteger(number) || number <= 0)
    return {
      ...base,
      key: `task:${taskRef}`,
      ref: taskRef,
      repository: null,
      number: null,
      unreadable: "not_github",
      url: null,
    };
  const repository = resolveFrameRepository(named, "", checkouts, repositories);
  return {
    ...base,
    key: keyOf(repository, number),
    ref: refOf(repository, number),
    repository,
    number,
    unreadable: repository === null ? "repository_unknown" : null,
    url: fromUrl?.url ?? null,
  };
}

function numericSeq(seq: string): number {
  return Number(seq);
}

export function createRunIssuesGetHandler(
  deps: RunIssuesDeps,
): CapabilityHandler<typeof runIssuesGet> {
  return async (input, ctx): Promise<RunIssuesGetOutput> => {
    // The roles get_run_work checks: the issues come from the same record.
    const userId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId },
      { org: ["Owner", "Admin"], workspace: ["Owner", "Member"] },
    );
    const scope = runScope(ctx);
    const run = await resolveRun(deps, ctx, input.runId);
    const warnings = new Set<string>();
    const repositories = await deps.repositories(scope);
    let checkouts: RunCheckout[] = [];
    let frames: Awaited<ReturnType<typeof readRunCommandRefFrames>> = [];
    const pulls: ClosingPullRequest[] = [];

    if (run.source === "tacho") {
      const [contexts, links, commandFrames] = await Promise.all([
        deps.contexts(run.sessionUuid),
        deps.prLinks(run.sessionUuid),
        deps.commandFrames(run.sessionUuid),
      ]);
      checkouts = contexts
        .slice(0, WORK_CONTEXT_CAP)
        .map((row) => checkoutOf(row, repositories));
      frames = commandFrames;
      // A link past the cap is a pull request whose closing list is unread.
      if (links.length > WORK_PR_LINK_CAP) warnings.add("closing_issue_limit");
      for (const row of links.slice(0, WORK_PR_LINK_CAP)) {
        const link = prLinkOf(row);
        if (link === null) continue;
        const repository = repositories.find(
          (candidate) =>
            candidate.owner.toLowerCase() === link.owner.toLowerCase() &&
            candidate.name.toLowerCase() === link.name.toLowerCase(),
        );
        if (repository === undefined) {
          warnings.add("recorded_repository_not_connected");
          continue;
        }
        pulls.push({
          repository,
          number: link.number,
          url: link.url,
          seq: String(row.first_seq),
        });
      }
      if (run.row.session.chainVerified === false) warnings.add("chain_break");
    } else {
      const ledger = await readLedgerPrReceipts(deps.store, run.runId);
      if (!ledger.complete) warnings.add("ledger_event_limit");
      for (const receipt of ledger.receipts) {
        const repository = repositories.find(
          (candidate) => candidate.providerRepositoryId === receipt.repositoryId,
        );
        if (repository === undefined) {
          warnings.add("recorded_repository_not_connected");
          continue;
        }
        pulls.push({
          repository,
          number: receipt.number,
          url: `${repository.url}/pull/${String(receipt.number)}`,
          seq: receipt.seq ?? null,
        });
      }
    }

    const drafts = new Map<string, Draft>();
    const merge = (draft: Draft) => {
      const found = drafts.get(draft.key);
      if (found === undefined) {
        drafts.set(draft.key, draft);
        return;
      }
      if (RELATION_RANK[draft.relation] < RELATION_RANK[found.relation])
        found.relation = draft.relation;
      for (const [number, url] of draft.resolvedBy)
        found.resolvedBy.set(number, url);
      for (const action of draft.actions)
        if (!found.actions.includes(action)) found.actions.push(action);
      for (const seq of draft.frameSeqs) found.frameSeqs.add(seq);
      found.url ??= draft.url;
      found.closingState ??= draft.closingState;
      found.repository ??= draft.repository;
    };

    const taskRef = run.item.taskRef;
    if (taskRef !== null && taskRef.trim() !== "")
      merge(taskDraft(taskRef.trim(), checkouts, repositories));

    const closing = await deps.closingIssues(scope, pulls);
    for (const warning of closing.warnings) warnings.add(warning);
    for (const { pull, issues } of closing.closing) {
      for (const issue of issues) {
        const named = { owner: issue.owner, name: issue.repo };
        const repository = resolveFrameRepository(
          named,
          "",
          checkouts,
          repositories,
        );
        merge({
          key: keyOf(named, issue.number),
          ref: refOf(named, issue.number),
          repository,
          number: issue.number,
          relation: "resolves",
          unreadable: null,
          resolvedBy: new Map([[pull.number, pull.url]]),
          actions: [],
          frameSeqs: new Set(pull.seq === null ? [] : [pull.seq]),
          url: issue.url,
          closingState: { title: issue.title, state: issue.state },
        });
      }
    }

    if (frames.length > COMMAND_REF_FRAME_CAP) warnings.add("issue_frame_limit");
    for (const row of frames.slice(0, COMMAND_REF_FRAME_CAP)) {
      for (const ref of issueRefsOfFrame(row)) {
        const repository = resolveFrameRepository(
          ref.repository,
          row.path,
          checkouts,
          repositories,
        );
        merge({
          key: keyOf(repository, ref.number),
          ref: refOf(repository, ref.number),
          repository,
          number: ref.number,
          relation: "referenced",
          unreadable: repository === null ? "repository_unknown" : null,
          resolvedBy: new Map(),
          actions: [ref.action],
          frameSeqs: new Set([String(row.seq)]),
          url: ref.url,
          closingState: null,
        });
      }
    }

    // The closing list already carries GitHub's state; every other issue in
    // a known repository is read from the tracker.
    const readAt = new Date().toISOString();
    const requests: IssueStateRequest[] = [];
    for (const draft of drafts.values())
      if (
        draft.unreadable === null &&
        draft.closingState === null &&
        draft.repository !== null &&
        draft.number !== null
      )
        requests.push({
          key: draft.key,
          repository: draft.repository,
          number: draft.number,
        });
    const tracker = await deps.tracker(scope, requests, repositories);
    for (const warning of tracker.warnings) warnings.add(warning);

    const rows: { row: RunIssue; firstSeq: number }[] = [];
    for (const draft of drafts.values()) {
      const state: IssueState =
        draft.unreadable !== null
          ? {
              title: null,
              status: null,
              statusRead: draft.unreadable,
              readAt: null,
              url: null,
              isPullRequest: false,
            }
          : draft.closingState !== null
            ? {
                title: draft.closingState.title,
                status: draft.closingState.state,
                statusRead: "read",
                readAt,
                url: null,
                isPullRequest: false,
              }
            : (tracker.states.get(draft.key) ?? {
                title: null,
                status: null,
                statusRead: "read_failed",
                readAt: null,
                url: null,
                isPullRequest: false,
              });
      if (state.isPullRequest) {
        // GitHub numbers issues and pull requests from one sequence. A
        // number a frame named that is a pull request is not an issue, and
        // the task keeps its row with no issue state.
        warnings.add("pull_request_ref_skipped");
        if (draft.relation !== "task") continue;
      }
      const seqs = [...draft.frameSeqs].sort(
        (a, b) => numericSeq(a) - numericSeq(b),
      );
      const first = seqs[0];
      rows.push({
        firstSeq:
          first === undefined ? Number.POSITIVE_INFINITY : numericSeq(first),
        row: {
          ref: draft.ref,
          repository: draft.repository,
          number: draft.number,
          title: state.isPullRequest ? null : state.title,
          status: state.isPullRequest ? null : state.status,
          statusRead: state.isPullRequest ? "not_found" : state.statusRead,
          readAt: state.isPullRequest ? null : state.readAt,
          relation: draft.relation,
          resolvedBy:
            draft.relation === "resolves"
              ? [...draft.resolvedBy]
                  .sort(([a], [b]) => a - b)
                  .slice(0, ROW_REF_MAX)
                  .map(([number, url]) => ({ number, url }))
              : [],
          actions: draft.actions,
          edge: draft.relation === "task" ? "stated" : "observed",
          frameSeqs: seqs.slice(0, ROW_REF_MAX),
          url:
            (state.isPullRequest ? null : state.url) ??
            draft.url ??
            issuePage(draft.repository, draft.number),
        },
      });
    }
    // The task first, then each issue by the first frame that names it; an
    // issue no frame names (a ledger run's closing issue) comes last, in the
    // order its pull request was read.
    rows.sort(
      (a, b) =>
        Number(b.row.relation === "task") - Number(a.row.relation === "task") ||
        a.firstSeq - b.firstSeq,
    );
    if (rows.length > RUN_ISSUE_MAX) warnings.add("issue_frame_limit");
    const list = [...warnings];
    return {
      runId: input.runId,
      issues: rows.slice(0, RUN_ISSUE_MAX).map(({ row }) => row),
      complete: !list.some((warning) => LIST_CUTTING.has(warning)),
      warnings: list,
    };
  };
}

export const runIssuesGetHandler = createRunIssuesGetHandler({
  ...defaultRunReadDeps(),
  contexts: readWorkContexts,
  prLinks: readWorkPrLinks,
  commandFrames: readRunCommandRefFrames,
  repositories: connectedRunRepositories,
  closingIssues: readClosingIssues,
  tracker: readIssueStates,
});
