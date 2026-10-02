// code-repo-check/run.ts: one Oxagen check on one pull request in a linked
// code repository, for one workspace (S2b, #5058; steering-repo-spec, Code
// repository checks).
//
// 1. List the instruction files the pull request changes.
// 2. Read each at the base and at the head, and keep the statements the head
//    adds (statements.ts).
// 3. Compare them with the workspace's active steering records
//    (findings.ts): a repeat or a contradiction is a finding.
// 4. Hand every added statement that is not a finding to S6's memory capture
//    (`ingestMemories`, capture `pull_request`), with the pull request as
//    evidence. A memory waits for the curator and a person, as every memory
//    does. Capture runs before the check posts, so a capture that throws
//    retries the whole job and the check never claims lines it lost.
// 5. Post the check. It warns unless the published workspace.toml sets
//    `[code_checks] block_merge = true`.
//
// The caller runs this inside the workspace's tenant scope.
import type {
  CodeRepoCheckOutcome,
  CodeRepoCheckRequest,
} from "@oxagen/inngest-functions/code-repo-check-runner";
import { repoRef } from "@oxagen/oxagen/steering-repo/names";
import { compareStatements, type PublishedStatement } from "./findings";
import { splitFullName, type CodeHost } from "./host";
import { appliesToOf, isInstructionFile } from "./instruction-files";
import { buildReport } from "./report";
import { addedStatements, type AddedStatement } from "./statements";

/** The most instruction files one check reads. */
export const INSTRUCTION_FILES_MAX = 20;
/** The most added statements one check compares. */
export const STATEMENTS_MAX = 500;
/** The most memories one check hands to capture. */
export const MEMORIES_MAX = 50;
/** The longest statement memory capture takes (`lessonInputSchema`). */
export const MEMORY_STATEMENT_MAX = 2000;

export interface CheckScope {
  orgId: string;
  workspaceId: string;
}

/** One memory for `ingestMemories`, in the shape `memoryIntakeSchema` reads. */
export interface PullRequestMemory {
  capture: "pull_request";
  source: string;
  agentLineage: null;
  runPublicId: null;
  statement: string;
  kind: "memory";
  repos?: string[];
  applies_to?: string[];
  evidence: string[];
}

export interface CodeRepoCheckDeps {
  /** The repository's host, with the credential the request names. */
  host(request: CodeRepoCheckRequest): Promise<CodeHost>;
  /** The workspace's slug, which the summary names. */
  workspaceSlug(scope: CheckScope): Promise<string>;
  /** The workspace's active steering records. */
  publishedRecords(scope: CheckScope): Promise<PublishedStatement[]>;
  /**
   * `[code_checks]` as the published workspace.toml sets it. A workspace with
   * no published version, or a file that does not read, warns.
   */
  blockMerge(scope: CheckScope): Promise<boolean>;
  /** S6's capture entry point for memories from outside a run. */
  captureMemories(
    scope: CheckScope,
    memories: PullRequestMemory[],
  ): Promise<{ written: number; refused: number }>;
  now(): Date;
}

/** The repository as records name it, or null when its name does not read as one. */
function repositoryRefOf(request: CodeRepoCheckRequest): string | null {
  const cut = request.fullName.lastIndexOf("/");
  if (cut <= 0) return null;
  const host = request.provider === "gitlab" ? "gitlab.com" : "github.com";
  try {
    return repoRef(host, request.fullName.slice(0, cut), request.fullName.slice(cut + 1));
  } catch {
    return null;
  }
}

/** The web page of a file's line at the head commit. */
export function fileLineUrl(
  request: CodeRepoCheckRequest,
  statement: AddedStatement,
): string {
  const path = statement.path.split("/").map(encodeURIComponent).join("/");
  if (request.provider === "gitlab")
    return `https://gitlab.com/${request.fullName}/-/blob/${request.headSha}/${path}#L${statement.line}`;
  const { owner, name } = splitFullName(request.fullName);
  return `https://github.com/${owner}/${name}/blob/${request.headSha}/${path}#L${statement.line}`;
}

/**
 * The memories a pull request's new statements make. A statement too long for
 * a memory is left out, and so is a second copy of one already taken, such as
 * the same line added to AGENTS.md and CLAUDE.md.
 */
export function pullRequestMemories(
  request: CodeRepoCheckRequest,
  fresh: readonly AddedStatement[],
): PullRequestMemory[] {
  const repo = repositoryRefOf(request);
  const seen = new Set<string>();
  const memories: PullRequestMemory[] = [];
  for (const statement of fresh) {
    if (memories.length >= MEMORIES_MAX) break;
    if (statement.text.length > MEMORY_STATEMENT_MAX) continue;
    const key = statement.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const appliesTo = appliesToOf(statement.path);
    memories.push({
      capture: "pull_request",
      source: request.url,
      agentLineage: null,
      runPublicId: null,
      statement: statement.text,
      kind: "memory",
      ...(repo === null ? {} : { repos: [repo] }),
      ...(appliesTo === null ? {} : { applies_to: [appliesTo] }),
      evidence: [request.url, fileLineUrl(request, statement)],
    });
  }
  return memories;
}

/** Run the check and post it. */
export async function runCodeRepoCheck(
  deps: CodeRepoCheckDeps,
  request: CodeRepoCheckRequest,
): Promise<CodeRepoCheckOutcome> {
  const scope = { orgId: request.orgId, workspaceId: request.workspaceId };
  const startedAt = deps.now().toISOString();
  const host = await deps.host(request);

  const files = (await host.changedPaths(request.base, request.headSha))
    .filter(isInstructionFile)
    .sort();
  const added: AddedStatement[] = [];
  for (const path of files.slice(0, INSTRUCTION_FILES_MAX)) {
    const [before, after] = await Promise.all([
      host.readFile(path, request.base),
      host.readFile(path, request.headSha),
    ]);
    if (after === null) continue;
    added.push(...addedStatements(path, before, after));
  }

  const workspace = await deps.workspaceSlug(scope);
  let findings: ReturnType<typeof compareStatements>["findings"] = [];
  let blockMerge = false;
  let memories = 0;
  if (added.length > 0) {
    const [records, block] = await Promise.all([
      deps.publishedRecords(scope),
      deps.blockMerge(scope),
    ]);
    blockMerge = block;
    const comparison = compareStatements(added.slice(0, STATEMENTS_MAX), records);
    findings = comparison.findings;
    const inputs = pullRequestMemories(request, comparison.fresh);
    if (inputs.length > 0) {
      const captured = await deps.captureMemories(scope, inputs);
      memories = inputs.length - captured.refused;
    }
  }

  const report = buildReport({ workspace, files, findings, blockMerge, memories });
  await host.postCheck({
    headSha: request.headSha,
    report,
    startedAt,
    completedAt: deps.now().toISOString(),
    workspaceId: request.workspaceId,
  });
  return {
    conclusion: report.conclusion,
    files: files.length,
    findings: findings.length,
    memories,
  };
}
