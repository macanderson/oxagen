// audit-exempt: opening the PR publishes nothing (the record steers nothing until merge, MC spec §10.3); the kernel capability.invoke_* audit records the open and merge_context_pr emits steering.published.
//
// open_context_pr (ADR-061; MC spec §10.3 steps 1-2). On a `proposed` row:
// the branch `context/<lineage>` from the production branch, the single
// record file, the PR, then the six checks one at a time — each outcome is
// written to the row before the next check starts, and mirrored to GitHub as
// a check run. On a row whose PR is already open the checks run again on the
// same PR. The file that is checked is the one read back from the branch,
// never the text this process built.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { contextPrOpen } from "@oxagen/oxagen/contracts/context.pr.open";
import {
  CHECK_NAMES,
  type CheckName,
  type CheckResult,
  type ConstraintEffect,
  type PublishedSharingScope,
  type RecordForce,
  type RecordKind,
} from "@oxagen/oxagen/contracts/context.steering.shared";
import { assertOrgRole } from "@oxagen/iam/org-role";
import {
  CHECK_TITLES,
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
import type { SteeringRepository } from "./context.steering.github";
import {
  GOVERNANCE_PATH,
  parseGovernanceMode,
} from "./context.steering.policy";
import type { ProposalRow } from "./context.steering.store";
import { contextPrView, prBody } from "./context.steering.view";

const OPEN_PR = new Set([
  "pr_open",
  "checks_running",
  "checks_passed",
  "checks_failed",
]);

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
export function setIdFor(repo: SteeringRepository): string {
  return repo.fullName.replace(/\//g, ".");
}

export function createOpenContextPrHandler(
  deps: Pick<SteeringDeps, "store" | "github" | "now">,
): CapabilityHandler<typeof contextPrOpen> {
  return async (input, ctx) => {
    await assertOrgRole(ctx, {
      org: ["Owner", "Admin"],
      workspace: ["Owner", "Member"],
    });
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
      throw new HandlerError({
        code: "conflict",
        reason: `proposal_${row.status}`,
        message: `Proposal ${row.publicId} is ${row.status}`,
      });
    }
    if (!OPEN_PR.has(row.status)) {
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
    if (!OPEN_PR.has(row.status)) {
      const file = buildRecordFile({
        lineageId: row.lineageId,
        kind: row.kind as RecordKind,
        force: row.force as RecordForce,
        sharingScope: row.sharingScope as PublishedSharingScope,
        statement: row.statement,
        origin: ctx.userId ? "user" : "inferred",
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
      const pr = await deps.github.openPullRequest(repo, {
        title: `Context PR: ${row.lineageId}`,
        head: branch,
        base: repo.defaultBranch,
        body: prBody(stamped),
      });
      row = await deps.store.updateProposal(row.id, {
        status: "pr_open",
        governanceMode: mode,
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
        updatedByUserId: ctx.userId ?? null,
      });
    } else {
      row = await deps.store.updateProposal(row.id, {
        governanceMode: mode,
        checks: pendingChecks(),
        updatedByUserId: ctx.userId ?? null,
      });
    }

    row = await deps.store.updateProposal(row.id, { status: "checks_running" });
    const fileText = await deps.github.readFile(repo, path, branch);
    if (fileText === null) {
      throw new HandlerError({
        code: "conflict",
        reason: "record_file_missing",
        message: `${path} is not on ${branch}`,
      });
    }
    const [published, active] = await Promise.all([
      deps.store.findRecord(scope, row.lineageId),
      deps.store.listActiveRecords(scope),
    ]);
    const checkCtx: CheckContext = {
      fileText,
      path,
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

    const headSha = row.headSha;
    const setCheck = async (name: CheckName, patch: Partial<CheckResult>) => {
      const checks = row!.checks.map((c) =>
        c.name === name ? { ...c, ...patch } : c,
      );
      row = await deps.store.updateProposal(row!.id, { checks });
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
        const detailsUrl = headSha
          ? await deps.github.reportCheckRun(repo, {
              name: `Oxagen · ${CHECK_TITLES[name]}`,
              headSha,
              conclusion: outcome.ok ? "success" : "failure",
              title: CHECK_TITLES[name],
              summary: outcome.summary,
              startedAt,
              completedAt,
            })
          : null;
        await setCheck(name, {
          status: outcome.ok ? "passed" : "failed",
          summary: outcome.summary,
          detailsUrl,
          completedAt,
        });
      },
    });

    row = await deps.store.updateProposal(row.id, {
      status: allPassed ? "checks_passed" : "checks_failed",
    });
    return contextPrView(row, await deps.store.ledgerLength(scope), null);
  };
}

export const openContextPrHandler = createOpenContextPrHandler(steeringDeps());
