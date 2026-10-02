"use server";
// What the creation wizards read and write (roadmap creation-spec §1). The
// wizard host is mounted by the workspace layout and opens over any page, so
// it reads on demand, when a person opens it, and resolves its own viewer
// exactly as a write does (ARCHITECTURE.md §2, ADR-089): the main repository
// every wizard's pull request targets. The writes are the pull requests
// themselves. Nothing here writes the thing being created: each write cuts a
// branch in the workspace's main repository and opens a pull request, and the
// thing exists when a person merges it. The one row is the steering record's
// proposal, which is the steering PR's own state machine (MC spec §10.3) and
// steers nothing.
import { steeringPrOpen } from "@oxagen/oxagen/contracts/steering.pr.open";
import { steeringProposalCreate } from "@oxagen/oxagen/contracts/steering.proposal.create";
import { contextSteeringFreshness } from "@oxagen/oxagen/contracts/context.steering.freshness";
import { contextSteeringLayout } from "@oxagen/oxagen/contracts/context.steering.layout";
import { skillPropose } from "@oxagen/oxagen/contracts/skill.propose";
import type { ActionResult, ContractOutput } from "@/server/kernel";
import { kernelRead, kernelWrite, readToActionResult } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";
import type { RecordChoice, RepoLayout } from "./record-file";

/**
 * The main repository a wizard's pull request targets, and the layout its
 * production branch carries (#4765): `steering` when it holds
 * `steering/governance.toml`, `legacy` otherwise, null while the layout read
 * failed. The wizard's preview needs this to show the path and branch
 * open_steering_pr will actually write, because the two layouts disagree on
 * both. Null while the workspace binds no repository.
 */
type MainRepository = {
  fullName: string;
  defaultRef: string;
  layout: RepoLayout;
} | null;

export async function readMainRepository(
  org: string,
  ws: string,
): Promise<ActionResult<MainRepository>> {
  const ctx = await requireViewer(org, ws);
  const [freshnessRead, layoutRead] = await Promise.all([
    kernelRead(ctx, {
      contract: contextSteeringFreshness,
      input: {},
      page: "repositories",
    }),
    kernelRead(ctx, {
      contract: contextSteeringLayout,
      input: {},
      page: "repositories",
    }),
  ]);
  const result = readToActionResult(freshnessRead);
  if (!result.ok) return result;
  const { repository, defaultBranch } = result.value;
  const layout: RepoLayout = layoutRead.ok ? layoutRead.value.layout : null;
  return {
    ok: true,
    value:
      repository === null || defaultBranch === null
        ? null
        : { fullName: repository, defaultRef: defaultBranch, layout },
  };
}

export type ProposedSkill = Pick<
  ContractOutput<typeof skillPropose>,
  | "name"
  | "path"
  | "branch"
  | "repository"
  | "baseRef"
  | "version"
  | "replaces"
  | "digest"
  | "tokens"
  | "budget"
  | "pullRequest"
>;

/**
 * The skill wizard's last step: propose_skill runs the six checks and, when
 * they pass, opens the pull request. A failed check comes back as `conflict`
 * with `skill_check_<name>`, and nothing was written.
 */
export async function proposeSkill(
  org: string,
  ws: string,
  input: {
    origin: "describe" | "upload";
    name: string;
    body: string;
    files: readonly { path: string; content: string }[];
    rationale: string;
  },
): Promise<ActionResult<ProposedSkill>> {
  const ctx = await requireViewer(org, ws);
  const rationale = input.rationale.trim();
  const result = await kernelWrite(ctx, skillPropose, {
    origin: input.origin,
    name: input.name,
    body: input.body,
    files: input.files.map((f) => ({ path: f.path, content: f.content })),
    ...(rationale === "" ? {} : { rationale }),
  });
  if (!result.ok) return result;
  const out = result.value;
  return {
    ok: true,
    value: {
      name: out.name,
      path: out.path,
      branch: out.branch,
      repository: out.repository,
      baseRef: out.baseRef,
      version: out.version,
      replaces: out.replaces,
      digest: out.digest,
      tokens: out.tokens,
      budget: out.budget,
      pullRequest: out.pullRequest,
    },
  };
}

// ── The steering-record wizard (roadmap creation-spec §5; MC spec §10) ────────

/**
 * The steering-record wizard's first write: propose_record stores the record
 * the operator chose as a proposal on its lineage, with the description as the
 * rationale the pull request carries. A proposal steers nothing (MC spec
 * §10.3). It is the steering PR's state, not the record: the record exists
 * when the pull request merges.
 */
export async function proposeRecord(
  org: string,
  ws: string,
  input: {
    record: RecordChoice;
    rationale: string;
  },
): Promise<ActionResult<{ proposalId: string; lineageId: string }>> {
  const ctx = await requireViewer(org, ws);
  // A create never revises: a label need not be unique, so a new record can
  // derive a slug another record holds, and createOnly refuses it rather than
  // proposing a new version of that record (ADR-178).
  const result = await kernelWrite(ctx, steeringProposalCreate, {
    record: input.record,
    rationale: input.rationale.trim(),
    support: {},
    createOnly: true,
  });
  return result.ok
    ? {
        ok: true,
        value: {
          proposalId: result.value.proposalId,
          lineageId: result.value.lineageId,
        },
      }
    : result;
}

export type OpenedRecord = {
  proposalId: string;
  lineageId: string;
  status: ContractOutput<typeof steeringPrOpen>["status"];
  pr: {
    number: number;
    url: string;
    repository: string;
    branch: string;
    path: string;
  } | null;
  checks: { name: string; status: string; summary: string }[];
};

/**
 * The wizard's last write: open_steering_pr cuts a branch from the main
 * repository's production branch, commits the one record file at the path
 * its layout uses, opens the pull request, and runs the six checks. It
 * answers with where the checks stopped, and with the path and branch it
 * actually wrote (`pr.path`, `pr.branch`), which is the source of truth for
 * every step after this one.
 */
export async function openRecordPr(
  org: string,
  ws: string,
  proposalId: string,
): Promise<ActionResult<OpenedRecord>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, steeringPrOpen, { proposalId });
  if (!result.ok) return result;
  const out = result.value;
  return {
    ok: true,
    value: {
      proposalId: out.proposalId,
      lineageId: out.lineageId,
      status: out.status,
      pr:
        out.pr === null
          ? null
          : {
              number: out.pr.number,
              url: out.pr.url,
              repository: out.pr.repository,
              branch: out.pr.branch,
              path: out.pr.path,
            },
      checks: out.checks.map((c) => ({
        name: c.name,
        status: c.status,
        summary: c.summary,
      })),
    },
  };
}
