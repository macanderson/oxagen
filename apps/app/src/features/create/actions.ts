"use server";
// What the creation wizards read and write (roadmap creation-spec §1). The
// wizard host is mounted by the workspace layout and opens over any page, so
// it reads on demand, when a person opens it, and resolves its own viewer
// exactly as a write does (ARCHITECTURE.md §2, ADR-089): the main repository
// every wizard's pull request targets. The writes are the pull requests
// themselves. Nothing here writes a row: each write cuts a branch in the
// workspace's main repository and opens a pull request, and the thing exists
// when a person merges it.
import { agentPropose } from "@oxagen/oxagen/contracts/agent.propose";
import { repositoryMainGet } from "@oxagen/oxagen/contracts/repository.main.get";
import { skillPropose } from "@oxagen/oxagen/contracts/skill.propose";
import { toolVersionList } from "@oxagen/oxagen/contracts/tool.version.list";
import type { ActionResult, ContractOutput } from "@/server/kernel";
import { kernelRead, kernelWrite, readToActionResult } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

/** The main repository a wizard's pull request targets; null while the workspace binds none. */
type MainRepository = { fullName: string; defaultRef: string } | null;

export async function readMainRepository(
  org: string,
  ws: string,
): Promise<ActionResult<MainRepository>> {
  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, {
    contract: repositoryMainGet,
    input: {},
    page: "workspaceSettings",
  });
  const result = readToActionResult(read);
  if (!result.ok) return result;
  const repo = result.value.repository;
  return {
    ok: true,
    value:
      repo === null
        ? null
        : { fullName: repo.fullName, defaultRef: repo.defaultRef },
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

/** One page of the workspace's tool registry is the belt the wizard offers. */
const BELT_PAGE = 100;

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
  /** More versions exist than the one page the step shows. */
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
  const read = await kernelRead(ctx, {
    contract: toolVersionList,
    input: { limit: BELT_PAGE },
    page: "tools",
  });
  const result = readToActionResult(read);
  if (!result.ok) return result;
  return {
    ok: true,
    value: {
      tools: result.value.items.map((v) => ({
        slug: v.slug,
        name: v.name,
        version: v.version,
        riskGrade: v.riskGrade,
        sideEffect: v.classification?.sideEffect ?? null,
        financial:
          v.classification?.consequenceTags.includes("moves_money") ?? false,
        killed: v.gate.kind !== "open",
      })),
      more: result.value.nextCursor !== null,
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
