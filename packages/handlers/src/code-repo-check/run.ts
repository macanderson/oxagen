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
// 5. Store the statements it flagged (ADR-263), replacing the pull request's
//    earlier ones, so the Repositories page and list_code_repository_findings
//    read them.
// 6. Post the check. It warns unless the published workspace.toml sets
//    `[code_checks] block_merge = true`.
//
// A closed pull request posts nothing. Closed without merging, its stored
// statements go. Merged, they stay, and every merged statement another pull
// request left on a file this merge touched is read again at the merge
// commit, and goes when the file no longer holds it.
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
import type {
  CheckedPullRequest,
  CodeRepoFindingStore,
  PullRequestKey,
} from "./store";

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
  /** The stored findings (ADR-263). */
  findings: Pick<
    CodeRepoFindingStore,
    "replacePullRequest" | "clearPullRequest" | "markMerged" | "mergedElsewhere" | "remove"
  >;
  now(): Date;
}

/** The pull request a request names, as the store keys it. */
function pullRequestOf(request: CodeRepoCheckRequest): CheckedPullRequest {
  return {
    provider: request.provider,
    providerRepositoryId: request.repositoryId,
    number: request.number,
    repository: request.fullName,
    url: request.url,
    headSha: request.headSha,
  };
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
  request: Pick<CodeRepoCheckRequest, "provider" | "fullName" | "headSha">,
  statement: Pick<AddedStatement, "path" | "line">,
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

/**
 * Settle a closed pull request's stored findings. Closed without merging,
 * they go. Merged, they stay, and the merged findings other pull requests
 * left on the files this one touched are read again at the merge commit.
 */
export async function settleClosedPullRequest(
  deps: CodeRepoCheckDeps,
  request: CodeRepoCheckRequest & { closed: NonNullable<CodeRepoCheckRequest["closed"]> },
): Promise<CodeRepoCheckOutcome> {
  const scope = { orgId: request.orgId, workspaceId: request.workspaceId };
  const pr: PullRequestKey = pullRequestOf(request);
  const settled = { conclusion: null, settled: request.closed, memories: 0 } as const;
  if (request.closed === "unmerged") {
    const gone = await deps.findings.clearPullRequest(scope, pr);
    return { ...settled, files: 0, findings: gone };
  }
  await deps.findings.markMerged(scope, pr, request.headSha);
  const held = await deps.findings.mergedElsewhere(scope, pr);
  // A merge the host names no commit for, such as a fast-forward on GitLab,
  // leaves the earlier findings as they are.
  if (held.length === 0 || request.mergeCommitSha === null)
    return { ...settled, files: 0, findings: 0 };
  const host = await deps.host(request);
  const touched = new Set(await host.touchedPaths(request.base, request.headSha));
  const paths = [...new Set(held.map((row) => row.path))]
    .filter((path) => touched.has(path))
    .sort()
    .slice(0, INSTRUCTION_FILES_MAX);
  const gone: string[] = [];
  for (const path of paths) {
    const text = await host.readFile(path, request.mergeCommitSha);
    // The statements the file holds at the merge, read as the check reads them.
    const kept = new Set(
      text === null ? [] : addedStatements(path, null, text).map((s) => s.text),
    );
    for (const row of held)
      if (row.path === path && !kept.has(row.statement)) gone.push(row.publicId);
  }
  await deps.findings.remove(scope, gone);
  return { ...settled, files: paths.length, findings: gone.length };
}

/** Run the check and post it, or settle a closed pull request's findings. */
export async function runCodeRepoCheck(
  deps: CodeRepoCheckDeps,
  request: CodeRepoCheckRequest,
): Promise<CodeRepoCheckOutcome> {
  if (request.closed !== null)
    return settleClosedPullRequest(deps, { ...request, closed: request.closed });
  const scope = { orgId: request.orgId, workspaceId: request.workspaceId };
  const startedAt = deps.now().toISOString();
  const host = await deps.host(request);

  const changed = (await host.changedFiles(request.base, request.headSha))
    .filter((file) => isInstructionFile(file.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const files = changed.map((file) => file.path);
  const added: AddedStatement[] = [];
  for (const { path, previousPath } of changed.slice(0, INSTRUCTION_FILES_MAX)) {
    // A renamed file is compared with its text under the old name, so a move
    // adds nothing.
    const [before, after] = await Promise.all([
      host.readFile(previousPath ?? path, request.base),
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
  // Stored before the check posts, so a write that throws retries the job
  // and the check never shows a finding the page cannot. A push that
  // removed every flagged line clears the earlier ones.
  await deps.findings.replacePullRequest(
    scope,
    pullRequestOf(request),
    findings.map(({ statement }) => ({
      path: statement.path,
      line: statement.line,
      text: statement.text,
    })),
    deps.now(),
  );

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
