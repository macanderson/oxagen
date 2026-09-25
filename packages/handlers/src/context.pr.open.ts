// audit-exempt: opening the PR publishes nothing (the record steers nothing until merge, MC spec §10.3); the kernel capability.invoke_* audit records the open and merge_context_pr emits steering.published.
//
// open_context_pr (ADR-061; MC spec §10.3 steps 1-2). On a `proposed` row:
// the branch `context/<lineage>` from the production branch, the single
// record file, the PR, then the six checks one at a time — each outcome is
// written to the row before the next check starts, and mirrored to GitHub as
// a check run. The row records the branch before GitHub is touched, so a call
// that failed after GitHub opened the PR is retried onto that PR; a PR on the
// branch is adopted only when its body names this proposal. On a row
// whose PR is already open the checks run again on the same PR, against its
// current head, while it still targets the production branch. The file that
// is checked is the one read back from that head, never the text this process
// built, together with every path the head changes; once every check passes
// the row carries the identity stamped in that file: the merge gate pins the
// merge to this head and the registry is written from the row. Every write
// after the checks start is tied to the head they read, so a re-run that
// recorded a newer head wins and this call's outcome is refused `head_moved`.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { contextPrOpen } from "@oxagen/oxagen/contracts/context.pr.open";
import {
  CHECK_NAMES,
  type CheckName,
  type CheckResult,
  type ConstraintEffect,
  type ProposalStatus,
  type PublishedSharingScope,
  type RecordForce,
  type RecordKind,
} from "@oxagen/oxagen/contracts/context.steering.shared";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import {
  CHECK_TITLES,
  parseChecked,
  runChecks,
  type CheckContext,
} from "./context.steering.checks";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";
import {
  buildRecordFile,
  contextBranch,
  recordFilePath,
  serializeRecordFile,
} from "./context.steering.file";
import {
  assertProductionBase,
  assertSameHost,
  mergedOutsideOxagen,
  type SteeringRepository,
} from "./context.steering.github";
import { OXAGEN_PR_LABELS } from "@oxagen/github";
import {
  GOVERNANCE_PATH,
  parseGovernanceMode,
} from "./context.steering.policy";
import { proposalMoved, type ProposalRow } from "./context.steering.store";
import {
  bodyNamesProposal,
  contextPrView,
  prBody,
} from "./context.steering.view";

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
  deps: Pick<SteeringDeps, "store" | "github" | "now">,
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
    const mode = parseGovernanceMode(
      await deps.github.readFile(repo, GOVERNANCE_PATH, repo.defaultBranch),
    );
    if (typeof mode !== "string") {
      throw new HandlerError({
        code: "conflict",
        reason: "governance_unreadable",
        message: mode.error,
      });
    }

    const path = recordFilePath(row.lineageId);
    const branch = contextBranch(row.lineageId);
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
      if (row.branch !== branch) {
        row = await deps.store.updateProposal(row.id, { branch }, ["proposed"]);
      }
      const file = buildRecordFile({
        lineageId: row.lineageId,
        kind: row.kind as RecordKind,
        force: row.force as RecordForce,
        sharingScope: row.sharingScope as PublishedSharingScope,
        statement: row.statement,
        // Who raised the proposal: a person, or an agent over an API key.
        origin: row.createdById ? "user" : "inferred",
        proposalPublicId: row.publicId,
        setId: setIdFor(repo),
      });
      const record = file.record[0]!;
      const stamped: ProposalRow = {
        ...row,
        stampedRecordId: record.record_id,
        recordHash: record.record_hash,
      };
      await deps.github.ensureBranch(repo, branch, repo.defaultBranch);
      const { commitSha } = await deps.github.putFile(repo, {
        path,
        content: serializeRecordFile(file),
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
          stampedRecordId: record.record_id,
          recordHash: record.record_hash,
          checks: pendingChecks(),
          updatedById: actingUserId,
        },
        ["proposed"],
      );
    } else {
      assertSameHost(repo, row.provider, row.prUrl);
      const pr = await deps.github.getPullRequest(repo, row.prNumber!);
      assertProductionBase(repo, pr.baseRef, row.prUrl);
      // A PR merged on the host at the commit the checks passed on is still
      // Oxagen's to publish, and merge_context_pr resumes it. Merged anywhere
      // else, the checks would only report on a head that can never change.
      const passedHere =
        row.status === "checks_passed" && pr.headSha === row.headSha;
      if (pr.merged && !passedHere) {
        throw mergedOutsideOxagen(
          row.prUrl,
          pr.headSha,
          row.status === "checks_passed" ? row.headSha : null,
        );
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
      );
    }

    row = await deps.store.updateProposal(
      row.id,
      { status: "checks_running" },
      OPEN_PR,
    );
    const headSha = row.headSha;
    if (!headSha) {
      throw new HandlerError({
        code: "conflict",
        reason: "head_unknown",
        message: `${row.prUrl ?? row.publicId} reports no head commit`,
      });
    }
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

    const setCheck = async (name: CheckName, patch: Partial<CheckResult>) => {
      const checks = row!.checks.map((c) =>
        c.name === name ? { ...c, ...patch } : c,
      );
      row = await deps.store.updateProposal(
        row!.id,
        { checks },
        ["checks_running"],
        { headSha },
      );
    };
    const allPassed = await runChecks(checkCtx, {
      start: async (name) => {
        await setCheck(name, {
          status: "running",
          startedAt: deps.now().toISOString(),
        });
      },
      finish: async (name, outcome) => {
        const startedAt =
          row!.checks.find((c) => c.name === name)?.startedAt ??
          deps.now().toISOString();
        const completedAt = deps.now().toISOString();
        const detailsUrl = await deps.github.reportCheckRun(repo, {
          name: `Oxagen · ${CHECK_TITLES[name]}`,
          headSha,
          conclusion: outcome.ok ? "success" : "failure",
          title: CHECK_TITLES[name],
          summary: outcome.summary,
          startedAt,
          completedAt,
        });
        await setCheck(name, {
          status: outcome.ok ? "passed" : "failed",
          summary: outcome.summary,
          detailsUrl,
          completedAt,
        });
      },
    });

    // Every check passed, so the file parses and its stamp recomputes: the
    // row now describes the record at this head, the one the merge publishes.
    const parsed = allPassed ? parseChecked(fileText) : null;
    row = await deps.store.updateProposal(
      row.id,
      {
        status: allPassed ? "checks_passed" : "checks_failed",
        ...(parsed?.ok
          ? {
              stampedRecordId: parsed.file.record[0]!.record_id,
              recordHash: parsed.file.record[0]!.record_hash,
            }
          : {}),
      },
      ["checks_running"],
      { headSha },
    );
    return contextPrView(row, await deps.store.ledgerLength(scope), null);
  };
}

export const openContextPrHandler = createOpenContextPrHandler(steeringDeps());
