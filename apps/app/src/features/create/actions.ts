"use server";
// What the creation wizards read and write (roadmap creation-spec §1). The
// wizard host is mounted by the workspace layout and opens over any page, so
// it reads on demand, when a person opens it, and resolves its own viewer
// exactly as a write does (ARCHITECTURE.md §2, ADR-089): the main repository
// every wizard's pull request targets. The writes are the pull requests
// themselves. Nothing here writes the thing being created: each write cuts a
// branch in the workspace's main repository and opens a pull request, and the
// thing exists when a person merges it. The one row is the context record's
// proposal, which is the Context PR's own state machine (MC spec §10.3) and
// steers nothing.
import { agentPropose } from "@oxagen/oxagen/contracts/agent.propose";
import { contextPrOpen } from "@oxagen/oxagen/contracts/context.pr.open";
import { contextProposalCreate } from "@oxagen/oxagen/contracts/context.proposal.create";
import { contextSteeringFreshness } from "@oxagen/oxagen/contracts/context.steering.freshness";
import { skillPropose } from "@oxagen/oxagen/contracts/skill.propose";
import { toolVersionList } from "@oxagen/oxagen/contracts/tool.version.list";
import type { Read } from "@/data/read";
import type { ActionResult, ContractOutput } from "@/server/kernel";
import { kernelRead, kernelWrite, readToActionResult } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";
import type { RecordChoice } from "./record-file";

/** The main repository a wizard's pull request targets; null while the workspace binds none. */
type MainRepository = { fullName: string; defaultRef: string } | null;

export async function readMainRepository(
  org: string,
  ws: string,
): Promise<ActionResult<MainRepository>> {
  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, {
    contract: contextSteeringFreshness,
    input: {},
    page: "repositories",
  });
  const result = readToActionResult(read);
  if (!result.ok) return result;
  const { repository, defaultBranch } = result.value;
  return {
    ok: true,
    value:
      repository === null || defaultBranch === null
        ? null
        : { fullName: repository, defaultRef: defaultBranch },
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

// ── The agent wizard (roadmap creation-spec §1; MC spec §6.2) ────────────────

/** The registry is read in pages of this many versions. */
const BELT_PAGE = 100;
/** The most pages the belt reads, so a picker can find any of 1,000 versions. */
const BELT_PAGES = 10;

export type ToolbeltOffer = {
  tools: {
    slug: string;
    name: string;
    version: number;
    riskGrade: "low" | "medium" | "high" | "critical";
    sideEffect: "read" | "write" | "irreversible" | null;
    financial: boolean;
    killed: boolean;
  }[];
  /** More versions exist than the pages the step read. */
  more: boolean;
};

/**
 * The toolbelt step's choices: the registry's active tool versions, each
 * with the classification that decides whether a call to it parks for a
 * person. A read, so it writes nothing.
 */
export async function readToolbelt(
  org: string,
  ws: string,
): Promise<ActionResult<ToolbeltOffer>> {
  const ctx = await requireViewer(org, ws);
  const items: ContractOutput<typeof toolVersionList>["items"] = [];
  let cursor: string | null = null;
  for (let page = 0; page < BELT_PAGES; page += 1) {
    // Annotated: the loop narrows `cursor` from this read's own answer, which
    // is circular for inference.
    const read: Read<ContractOutput<typeof toolVersionList>> = await kernelRead(
      ctx,
      {
        contract: toolVersionList,
        input:
          cursor === null ? { limit: BELT_PAGE } : { limit: BELT_PAGE, cursor },
        page: "tools",
      },
    );
    const result: ActionResult<ContractOutput<typeof toolVersionList>> =
      readToActionResult(read);
    if (!result.ok) return result;
    items.push(...result.value.items);
    cursor = result.value.nextCursor;
    if (cursor === null) break;
  }
  return {
    ok: true,
    value: {
      tools: items.map((v) => ({
        slug: v.slug,
        name: v.name,
        version: v.version,
        riskGrade: v.riskGrade,
        sideEffect: v.classification?.sideEffect ?? null,
        financial:
          v.classification?.consequenceTags.includes("moves_money") ?? false,
        killed: v.gate.kind !== "open",
      })),
      more: cursor !== null,
    },
  };
}

export type ProposedAgent = Pick<
  ContractOutput<typeof agentPropose>,
  | "slug"
  | "agentKey"
  | "path"
  | "generatedPath"
  | "branch"
  | "repository"
  | "baseRef"
  | "digest"
  | "pullRequest"
>;

/**
 * The agent wizard's last step: propose_agent runs the six checks and, when
 * they pass, opens the pull request with the definition and its generated
 * subagent file. A failed check comes back as `conflict` with
 * `agent_check_<name>`, and nothing was written.
 */
export async function proposeAgent(
  org: string,
  ws: string,
  input: {
    slug: string;
    harness:
      | "stella"
      | "claude-code"
      | "codex"
      | "cursor"
      | "claude-agent-sdk"
      | "custom";
    source: string;
    rationale: string;
  },
): Promise<ActionResult<ProposedAgent>> {
  const ctx = await requireViewer(org, ws);
  const rationale = input.rationale.trim();
  const result = await kernelWrite(ctx, agentPropose, {
    slug: input.slug,
    harness: input.harness,
    source: input.source,
    ...(rationale === "" ? {} : { rationale }),
  });
  if (!result.ok) return result;
  const out = result.value;
  return {
    ok: true,
    value: {
      slug: out.slug,
      agentKey: out.agentKey,
      path: out.path,
      generatedPath: out.generatedPath,
      branch: out.branch,
      repository: out.repository,
      baseRef: out.baseRef,
      digest: out.digest,
      pullRequest: out.pullRequest,
    },
  };
}

// ── The context-record wizard (roadmap creation-spec §5; MC spec §10) ────────

/**
 * The context-record wizard's first write: propose_record stores the record
 * the operator chose as a proposal on its lineage, with the description as the
 * rationale the pull request carries. A proposal steers nothing (MC spec
 * §10.3). It is the Context PR's state, not the record: the record exists
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
  // proposing a new version of that record (ADR-173).
  const result = await kernelWrite(ctx, contextProposalCreate, {
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
  status: ContractOutput<typeof contextPrOpen>["status"];
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
 * The wizard's last write: open_context_pr cuts `context/<lineage>` from the
 * main repository's production branch, commits the one record file, opens the
 * pull request, and runs the six checks. It answers with where the checks
 * stopped.
 */
export async function openRecordPr(
  org: string,
  ws: string,
  proposalId: string,
): Promise<ActionResult<OpenedRecord>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, contextPrOpen, { proposalId });
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
