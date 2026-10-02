// audit-exempt: opening the PR publishes nothing (the record steers nothing until merge, MC spec §10.3); the kernel capability.invoke_* audit records the open and merge_context_pr emits steering.published.
//
// open_context_pr (ADR-061; MC spec §10.3 steps 1-2). On a `proposed` row:
// a branch from the production branch, the single record file, the PR, then
// the six checks one at a time. Where the file goes depends on the repo's
// layout (#4731):
//
// - Legacy: `.oxagen/rules/<lineage>.toml` on `steering/<lineage>`.
// - Steering (steering/governance.toml on the production branch): a steering
//   record, `steering/<kind folder>/<lineage>.md` on `steering/<lineage>`, or
//   for a memory `steering/memory/workspace/general/<lineage>.md` on
//   `memory/<lineage>` (context.steering.record.ts).
//
// A revision is written where the record's file lives now.
//
// Each outcome is written to the row before the next check starts, and the
// host gets one required check, "Oxagen steering", with every outcome in its
// summary (steering-repo-spec, Steering PR flow). The row records the branch
// before the host is touched, so a call that failed after GitHub opened the
// PR is retried onto that PR; a PR on the branch is adopted only when its body
// names this proposal. On a row whose PR is already open the checks run again
// on the same PR, against its current head, while it still targets the
// production branch. The file that is checked is the one read back from that
// head, never the text this process built, together with every path the head
// changes; once every check passes the row carries the record's identity from
// that file (for a steering record, the id and hash the merge will stamp):
// the merge gate pins the merge to this head and the registry is written from
// the row. Every write
// after the checks start is tied to the head they read, so a re-run that
// recorded a newer head wins and this call's outcome is refused `head_moved`.
//
// In a steering repo the branch must also name the folder its paths live in;
// a branch that does not fails the Schema check. `recheckContextPr` runs the
// same checks when the merge queue brings a passed PR's branch up to date.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { contextPrOpen } from "@oxagen/oxagen/contracts/context.pr.open";
import {
  CHECK_NAMES,
  isSteeringPrKind,
  type CheckName,
  type CheckResult,
  type ConstraintEffect,
  type ProposalStatus,
  type PublishedSharingScope,
  type RecordForce,
  type RecordKind,
} from "@oxagen/oxagen/contracts/context.steering.shared";
import { REQUIRED_CHECK_NAME } from "@oxagen/oxagen/steering-repo/names";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { contextRecordLabel } from "@oxagen/oxagen/context-record-label";
import {
  CHECK_TITLES,
  parseChecked,
  runChecks,
  type CheckContext,
} from "./context.steering.checks";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";
import {
  buildRecordFile,
  recordFilePath,
  serializeRecordFile,
} from "./context.steering.file";
import {
  assertProductionBase,
  assertSameHost,
  refuseMergedOnHost,
  type SteeringRepository,
} from "./context.steering.github";
import { OXAGEN_PR_LABELS } from "@oxagen/github";
import {
  claimCutoff,
  mergeClaimed,
  mergeInProgress,
  proposalMoved,
  type ProposalRow,
} from "./context.steering.store";
import {
  isSteeringRecordPath,
  renderSteeringRecord,
  steeringRecordPath,
} from "./context.steering.record";
import { isRepositoryRecord } from "./context.steering.sync.plan";
import {
  bodyNamesProposal,
  contextPrView,
  prBody,
} from "./context.steering.view";
import {
  readSteeringLayout,
  type SteeringLayout,
} from "./steering-repo/merge-queue";
import {
  branchPrefixForPath,
  branchScopeRefusal,
  stampRecordText,
  steeringBranch,
} from "./steering-repo/stamp";

const OPEN_PR: readonly ProposalStatus[] = [
  "pr_open",
  "checks_running",
  "checks_passed",
  "checks_failed",
];
const isOpen = (status: string) => OPEN_PR.includes(status as ProposalStatus);

const pendingChecks = (): CheckResult[] =>
  CHECK_NAMES.map((name) => ({
    name,
    status: "pending",
    summary: "",
    detailsUrl: null,
    startedAt: null,
    completedAt: null,
  }));

/** The set id Stella writes at the top of the file: the repository, dotted. */
function setIdFor(repo: SteeringRepository): string {
  return repo.fullName.replace(/\//g, ".");
}

export function createOpenContextPrHandler(
  deps: Pick<SteeringDeps, "store" | "github" | "now" | "requestSync">,
): CapabilityHandler<typeof contextPrOpen> {
  return async (input, ctx) => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin"], workspace: ["Owner", "Member"] },
    );
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    let row = await deps.store.findProposal(scope, input.proposalId);
    if (!row) {
      throw new HandlerError({
        code: "not_found",
        reason: "proposal_not_found",
        message: `No proposal ${input.proposalId} in this workspace`,
      });
    }
    if (row.status === "merged" || row.status === "rejected") {
      throw proposalMoved(row.publicId, row.status);
    }
    // A governance proposal's PR changes steering/governance.toml, not a
    // record. set_governance_mode opens it and runs its checks (#4795).
    if (row.kind === "governance") {
      throw new HandlerError({
        code: "conflict",
        reason: "governance_proposal",
        message: `${row.prUrl ?? row.publicId} changes the governance mode, so the record checks do not apply. Set the mode again in the workspace's governance settings to run its checks.`,
      });
    }
    // A steering PR proposal's PR changes files, not one record. Its opener
    // opened the PR, and its merge runs the steering checks (#5122).
    if (isSteeringPrKind(row.kind)) {
      throw new HandlerError({
        code: "conflict",
        reason: "steering_pr_proposal",
        message: `${row.prUrl ?? row.publicId} is a ${row.kind.replace(/_/g, " ")} steering PR, so the record checks do not apply. Merge it from Oxagen: the merge runs the steering checks on its head first.`,
      });
    }
    if (!isOpen(row.status)) {
      const other = await deps.store.findOpenPrOnLineage(
        scope,
        row.lineageId,
        row.id,
      );
      if (other) {
        throw new HandlerError({
          code: "conflict",
          reason: "lineage_pr_open",
          message: `${other.prUrl ?? other.publicId} is already open for ${row.lineageId}; one concern, one pull request`,
        });
      }
    }

    const repo = await deps.github.resolveRepository(scope);
    const layout = await readSteeringLayout(deps.github, repo);
    const mode = layout.mode;

    // A revision is written where the record's file lives now. A person can
    // rename or move a record file on the host (ADR-184), and a revision
    // written to the derived path would leave a second file holding the same
    // lineage. A record the registry has never seen takes the derived path,
    // in the format the repo's layout reads.
    const held = await deps.store.findRecord(scope, row.lineageId);
    const heldPath = held?.record.path ?? null;
    const steering = layout.layout === "steering";
    const path =
      row.path ??
      (steering
        ? isSteeringRecordPath(heldPath)
          ? heldPath
          : steeringRecordPath(row.kind as RecordKind, row.lineageId)
        : isRepositoryRecord(heldPath) && heldPath
          ? heldPath
          : recordFilePath(row.lineageId));
    // A row that already names a branch keeps it: a retry, or a PR opened
    // on `context/<lineage>` before steering PRs took the `steering/` prefix.
    // In a steering repo the branch names the folder the file is in, so a
    // memory goes on `memory/<lineage>`.
    const branch =
      row.branch ??
      (steering
        ? `${branchPrefixForPath(path) ?? "steering"}/${row.lineageId}`
        : steeringBranch(row.lineageId));
    if (!isOpen(row.status)) {
      // An open PR on the branch is this proposal's only when an earlier call
      // for it opened the PR and failed before recording it: the body names it.
      const existing = await deps.github.findOpenPullRequest(repo, {
        head: branch,
        base: repo.defaultBranch,
      });
      if (existing && !bodyNamesProposal(existing.body, row.publicId)) {
        throw new HandlerError({
          code: "conflict",
          reason: "lineage_pr_open",
          message: `${existing.htmlUrl} is already open on ${branch}; one concern, one pull request`,
        });
      }
      // The file carries the record's name (ADR-178): the proposal's when it
      // renames the record, else the name the record already has, else one
      // derived from the slug. It is built before anything is written, so a
      // proposal the layout cannot hold is refused with nothing on the host.
      const label =
        row.label ?? held?.record.label ?? contextRecordLabel(row.lineageId);
      // Who raised the proposal: a person, or an agent over an API key.
      const origin = row.createdById ? ("user" as const) : ("inferred" as const);
      // The format follows the path: a steering record for a path the
      // steering layout reads as one, else a TOML record file. A row opened
      // before #4731 keeps its .oxagen/rules/ path, and its TOML file.
      let file: { content: string; id: string; hash: string };
      if (isSteeringRecordPath(path)) {
        // A revision keeps the fields the proposal does not own, such as
        // tools and applies_to, so it reads the file it replaces.
        const current =
          path === heldPath
            ? await deps.github.readFile(repo, path, repo.defaultBranch)
            : null;
        const record = renderSteeringRecord(
          {
            lineageId: row.lineageId,
            label,
            kind: row.kind as RecordKind,
            constraintEffect:
              (row.constraintEffect as ConstraintEffect | null) ?? null,
            force: row.force,
            sharingScope: row.sharingScope,
            statement: row.statement,
            origin,
            proposalPublicId: row.publicId,
          },
          current,
        );
        file = { content: record.text, id: record.id, hash: record.hash };
      } else {
        const toml = buildRecordFile({
          lineageId: row.lineageId,
          label,
          kind: row.kind as RecordKind,
          force: row.force as RecordForce,
          sharingScope: row.sharingScope as PublishedSharingScope,
          statement: row.statement,
          origin,
          proposalPublicId: row.publicId,
          setId: setIdFor(repo),
        });
        const record = toml.record[0]!;
        file = {
          content: serializeRecordFile(toml),
          id: record.record_id,
          hash: record.record_hash,
        };
      }
      if (row.branch !== branch) {
        row = await deps.store.updateProposal(row.id, { branch }, ["proposed"]);
      }
      const stamped: ProposalRow = {
        ...row,
        stampedRecordId: file.id,
        recordHash: file.hash,
      };
      await deps.github.ensureBranch(repo, branch, repo.defaultBranch);
      const { commitSha } = await deps.github.putFile(repo, {
        path,
        content: file.content,
        message: `steering: propose ${row.lineageId}`,
        branch,
      });
      const pr =
        existing ??
        (await deps.github.openPullRequest(repo, {
          title: `Context PR: ${row.lineageId}`,
          head: branch,
          base: repo.defaultBranch,
          body: prBody(stamped),
          labels: OXAGEN_PR_LABELS,
        }));
      row = await deps.store.updateProposal(
        row.id,
        {
          status: "pr_open",
          governanceMode: mode,
          provider: repo.provider,
          repository: repo.fullName,
          baseRef: repo.defaultBranch,
          branch,
          path,
          prNumber: pr.number,
          prUrl: pr.htmlUrl,
          headSha: commitSha,
          stampedRecordId: file.id,
          recordHash: file.hash,
          checks: pendingChecks(),
          updatedById: actingUserId,
        },
        ["proposed"],
      );
    } else {
      assertSameHost(repo, row.provider, row.prUrl);
      // A merge from Oxagen is landing this PR: its stamp commit is the PR's
      // head until the host merges it. Checks run on that head would move
      // the row the merge is about to publish (#4504).
      if (mergeClaimed(row, deps.now()))
        throw mergeInProgress(row.publicId, row.mergeClaimedAt);
      const pr = await deps.github.getPullRequest(repo, row.prNumber!);
      assertProductionBase(repo, pr.baseRef, row.prUrl);
      // A PR merged on the host at the commit the checks passed on is still
      // Oxagen's to publish, and merge_context_pr resumes it. Merged anywhere
      // else, the checks would only report on a head that can never change.
      const passedHere =
        row.status === "checks_passed" && pr.headSha === row.headSha;
      if (pr.merged && !passedHere) {
        await refuseMergedOnHost(deps, scope, row, pr.headSha);
      }
      row = await deps.store.updateProposal(
        row.id,
        {
          governanceMode: mode,
          headSha: pr.headSha,
          checks: pendingChecks(),
          updatedById: actingUserId,
        },
        OPEN_PR,
        { noClaimSince: claimCutoff(deps.now()) },
      );
    }

    row = await deps.store.updateProposal(
      row.id,
      { status: "checks_running" },
      OPEN_PR,
      { noClaimSince: claimCutoff(deps.now()) },
    );
    const headSha = row.headSha;
    if (!headSha) {
      throw new HandlerError({
        code: "conflict",
        reason: "head_unknown",
        message: `${row.prUrl ?? row.publicId} reports no head commit`,
      });
    }
    row = await runHeadChecks(deps, {
      scope,
      repo,
      row,
      layout,
      path,
      branch,
      headSha,
    });
    return contextPrView(row, await deps.store.ledgerLength(scope), null);
  };
}

type CheckDeps = Pick<SteeringDeps, "store" | "github" | "now">;

/**
 * The id and hash of the record in a file that passed every check. A steering
 * record carries neither until the merge stamps it, so they are the ones the
 * stamp will write. A TOML record file carries its own.
 */
function checkedIdentity(
  path: string,
  fileText: string,
): { id: string; hash: string } | null {
  if (isSteeringRecordPath(path)) {
    const stamped = stampRecordText(fileText);
    return stamped.ok ? { id: stamped.id, hash: stamped.hash } : null;
  }
  const parsed = parseChecked(fileText);
  if (!parsed.ok) return null;
  const record = parsed.file.record[0]!;
  return { id: record.record_id, hash: record.record_hash };
}

interface HeadChecks {
  scope: { orgId: string; workspaceId: string };
  repo: SteeringRepository;
  /** The row, in `checks_running` at `headSha`. */
  row: ProposalRow;
  layout: SteeringLayout;
  path: string;
  branch: string;
  headSha: string;
}

/**
 * Run the six checks on the PR's head and post their outcome as the one
 * required check. Each outcome is written to the row before the next check
 * starts, every write is tied to `headSha`, and the row ends in
 * `checks_passed` or `checks_failed`.
 */
async function runHeadChecks(
  deps: CheckDeps,
  input: HeadChecks,
): Promise<ProposalRow> {
  const { scope, repo, layout, path, branch, headSha } = input;
  let row = input.row;
  const [fileText, changedPaths] = await Promise.all([
    deps.github.readFile(repo, path, headSha),
    deps.github.changedPaths(repo, repo.defaultBranch, headSha),
  ]);
  if (fileText === null) {
    throw new HandlerError({
      code: "conflict",
      reason: "record_file_missing",
      message: `${path} is not at ${headSha} on ${branch}`,
    });
  }
  const [published, active] = await Promise.all([
    deps.store.findRecord(scope, row.lineageId),
    deps.store.listActiveRecords(scope),
  ]);
  const checkCtx: CheckContext = {
    fileText,
    path,
    changedPaths,
    proposal: {
      lineageId: row.lineageId,
      kind: row.kind as RecordKind,
      force: row.force,
      constraintEffect:
        (row.constraintEffect as ConstraintEffect | null) ?? null,
      sharingScope: row.sharingScope,
      statement: row.statement,
      label: row.label ?? null,
      rationale: row.rationale,
      evidenceLinks: row.evidenceLinks,
    },
    published: published
      ? { path: published.record.path, version: published.record.version }
      : null,
    activeRecords: active.map((r) => ({
      lineageId: r.slug,
      kind: (r.kind as RecordKind | null) ?? null,
      constraintEffect:
        (r.constraintEffect as ConstraintEffect | null) ?? null,
      statement: r.statement,
    })),
  };
  // A steering repo's PR changes only the folder its branch names. The
  // legacy layout keeps its records under .oxagen/rules/, which no steering
  // prefix names, so the rule applies to steering repos only.
  const outOfScope =
    layout.layout === "steering"
      ? branchScopeRefusal(branch, changedPaths)
      : null;

  const setCheck = async (name: CheckName, patch: Partial<CheckResult>) => {
    const checks = row.checks.map((c) =>
      c.name === name ? { ...c, ...patch } : c,
    );
    row = await deps.store.updateProposal(
      row.id,
      { checks },
      ["checks_running"],
      { headSha },
    );
  };
  let failed = 0;
  await runChecks(checkCtx, {
    start: async (name) => {
      await setCheck(name, {
        status: "running",
        startedAt: deps.now().toISOString(),
      });
    },
    finish: async (name, outcome) => {
      const ok = outcome.ok && !(name === "schema" && outOfScope);
      const summary =
        name === "schema" && outOfScope
          ? `${outcome.summary} ${outOfScope.message}.`.trim()
          : outcome.summary;
      if (!ok) failed += 1;
      await setCheck(name, {
        status: ok ? "passed" : "failed",
        summary,
        completedAt: deps.now().toISOString(),
      });
    },
  });
  const allPassed = failed === 0;

  // One required check carries every outcome, so branch protection names a
  // single check and a check added later needs no settings change.
  const detailsUrl = await deps.github.reportCheckRun(repo, {
    name: REQUIRED_CHECK_NAME,
    headSha,
    conclusion: allPassed ? "success" : "failure",
    title: allPassed
      ? "Steering checks passed"
      : `${failed} of ${CHECK_NAMES.length} steering checks failed`,
    summary: row.checks
      .map(
        (c) =>
          `- ${c.status === "passed" ? "Passed" : "Failed"}: ${CHECK_TITLES[c.name]}. ${c.summary}`.trimEnd(),
      )
      .join("\n"),
    startedAt: row.checks[0]?.startedAt ?? deps.now().toISOString(),
    completedAt: deps.now().toISOString(),
  });

  // Every check passed, so the file parses and its stamp recomputes: the
  // row now describes the record at this head, the one the merge publishes.
  const identity = allPassed ? checkedIdentity(path, fileText) : null;
  return deps.store.updateProposal(
    row.id,
    {
      status: allPassed ? "checks_passed" : "checks_failed",
      checks: row.checks.map((c) => ({ ...c, detailsUrl })),
      ...(identity
        ? { stampedRecordId: identity.id, recordHash: identity.hash }
        : {}),
    },
    ["checks_running"],
    { headSha },
  );
}

export interface Recheck {
  scope: { orgId: string; workspaceId: string };
  repo: SteeringRepository;
  /** The row in `checks_passed` at `from`. */
  row: ProposalRow;
  layout: SteeringLayout;
  path: string;
  branch: string;
  /** The head the checks passed on. */
  from: string;
  /** The head Oxagen made by bringing the branch up to date. */
  to: string;
  updatedById: string | null;
}

/**
 * Run the checks again after the merge queue brought a passed PR's branch up
 * to date with the production branch. The row moves to the new head and back
 * through `checks_running`, so the merge publishes the head that was checked.
 *
 * A failure partway, such as the record file missing at the new head, leaves
 * the row in `checks_running` at the new head. open_context_pr runs the
 * checks again from there.
 */
export async function recheckContextPr(
  deps: CheckDeps,
  input: Recheck,
): Promise<ProposalRow> {
  const row = await deps.store.updateProposal(
    input.row.id,
    {
      status: "checks_running",
      headSha: input.to,
      checks: pendingChecks(),
      updatedById: input.updatedById,
    },
    ["checks_passed"],
    { headSha: input.from },
  );
  return runHeadChecks(deps, {
    scope: input.scope,
    repo: input.repo,
    row,
    layout: input.layout,
    path: input.path,
    branch: input.branch,
    headSha: input.to,
  });
}

export interface CommittedHead {
  scope: { orgId: string; workspaceId: string };
  repo: SteeringRepository;
  /** The row, in any open status. */
  row: ProposalRow;
  layout: SteeringLayout;
  path: string;
  branch: string;
  /** The commit Oxagen just wrote on the branch. */
  to: string;
  updatedById: string | null;
}

/**
 * Run the checks on a commit Oxagen just wrote on an open Context PR's
 * branch, such as the one restore_managed_block writes (#4518). The row
 * moves to that commit from any open status, a failed run included, so the
 * checks read the head Oxagen made and not the host's view of the PR, which
 * can lag a push. A merge's claim refuses it, as it refuses a re-run.
 */
export async function checkCommittedHead(
  deps: CheckDeps,
  input: CommittedHead,
): Promise<ProposalRow> {
  const row = await deps.store.updateProposal(
    input.row.id,
    {
      status: "checks_running",
      headSha: input.to,
      checks: pendingChecks(),
      updatedById: input.updatedById,
    },
    OPEN_PR,
    { noClaimSince: claimCutoff(deps.now()) },
  );
  return runHeadChecks(deps, {
    scope: input.scope,
    repo: input.repo,
    row,
    layout: input.layout,
    path: input.path,
    branch: input.branch,
    headSha: input.to,
  });
}

export const openContextPrHandler = createOpenContextPrHandler(steeringDeps());
