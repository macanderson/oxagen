// code-repo-check/store.ts: the statements the Oxagen check flagged, kept in
// agent.code_repository_findings (S7, #4518; ADR-254).
//
// A row keeps what only the host can give: the repository, the pull request,
// the commit the check read, the file, the line, and the text. Which record
// the statement matches is not stored. The read compares it again with the
// workspace's records every time (findings.list.ts).
//
// A row follows its pull request:
// - Each check of an open pull request replaces its rows. A statement found
//   again in the same file keeps its row's id and proposal, so a page that
//   shows a finding can still promote it after the next push.
// - A pull request closed without merging deletes its rows.
// - A merged pull request keeps its rows, marked `merged`. A later merge that
//   changes the file deletes the rows whose statement it no longer holds
//   (run.ts).
//
// Every call runs in the workspace's tenant scope, which the caller opens.
import { randomInt } from "node:crypto";
import { schema, withTenantDb } from "@oxagen/database";
import type { CodeRepoProvider } from "@oxagen/inngest-functions/code-repo-check-runner";
import { and, asc, eq, inArray, ne } from "drizzle-orm";

export interface FindingScope {
  orgId: string;
  workspaceId: string;
}

/** One pull request, as the store keys its rows. */
export interface PullRequestKey {
  provider: CodeRepoProvider;
  /** GitHub's repository id or GitLab's project id. */
  providerRepositoryId: string;
  number: number;
}

/** The pull request a check read, with what each row records about it. */
export interface CheckedPullRequest extends PullRequestKey {
  /** `owner/name`, or the GitLab project path. */
  repository: string;
  url: string;
  /** The commit the check read. */
  headSha: string;
}

/** One statement the check flagged. */
export interface FlaggedStatement {
  path: string;
  /** The line the statement starts on, counted from 1. */
  line: number;
  text: string;
}

/** One stored row. */
export interface StoredFinding {
  publicId: string;
  provider: CodeRepoProvider;
  providerRepositoryId: string;
  repository: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  pullRequestState: "open" | "merged";
  headSha: string;
  path: string;
  line: number;
  statement: string;
  proposalPublicId: string | null;
  checkedAt: Date;
}

/** A row in a repository the workspace links, as the read and promote take it. */
export interface LinkedFinding extends StoredFinding {
  /** The workspace's binding of the repository (`rpb_…`). */
  repositoryId: string;
  /** The status of the proposal promote opened from it, or null. */
  proposalStatus: string | null;
}

export interface CodeRepoFindingStore {
  /** Replace an open pull request's rows with the statements its latest check flagged. */
  replacePullRequest(
    scope: FindingScope,
    pr: CheckedPullRequest,
    statements: readonly FlaggedStatement[],
    at: Date,
  ): Promise<void>;
  /** Delete a pull request's rows. Answers how many went. */
  clearPullRequest(scope: FindingScope, pr: PullRequestKey): Promise<number>;
  /** Mark a merged pull request's rows `merged`. */
  markMerged(scope: FindingScope, pr: PullRequestKey, headSha: string): Promise<void>;
  /** The merged rows other pull requests left in the same repository. */
  mergedElsewhere(scope: FindingScope, pr: PullRequestKey): Promise<StoredFinding[]>;
  /** Delete rows by id. */
  remove(scope: FindingScope, publicIds: readonly string[]): Promise<void>;
  /** Every row in a repository the workspace links, by repository, file, and line. */
  listLinked(scope: FindingScope): Promise<LinkedFinding[]>;
  /** One row in a repository the workspace links, or null. */
  findLinked(scope: FindingScope, publicId: string): Promise<LinkedFinding | null>;
  /** Record the proposal promote opened from a row. */
  setProposal(
    scope: FindingScope,
    publicId: string,
    proposalPublicId: string,
  ): Promise<void>;
}

/** The most rows the read returns: 20 files of 500 statements is the check's own limit per pull request. */
export const FINDINGS_READ_MAX = 1000;

const ID_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A new finding id: `crf_` and 22 random characters. */
export function newFindingId(): string {
  let id = "crf_";
  for (let i = 0; i < 22; i += 1) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return id;
}

/** The key a statement keeps its row by across checks: its file and its text. */
function statementKey(path: string, text: string): string {
  return JSON.stringify([path, text]);
}

const f = schema.codeRepositoryFindings;

const storedColumns = {
  publicId: f.publicId,
  provider: f.provider,
  providerRepositoryId: f.providerRepositoryId,
  repository: f.repository,
  pullRequestNumber: f.pullRequestNumber,
  pullRequestUrl: f.pullRequestUrl,
  pullRequestState: f.pullRequestState,
  headSha: f.headSha,
  path: f.path,
  line: f.line,
  statement: f.statement,
  proposalPublicId: f.proposalPublicId,
  checkedAt: f.checkedAt,
};

interface StoredRow {
  publicId: string;
  provider: string;
  providerRepositoryId: string;
  repository: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  pullRequestState: string;
  headSha: string;
  path: string;
  line: number;
  statement: string;
  proposalPublicId: string | null;
  checkedAt: Date;
}

function stored(row: StoredRow): StoredFinding {
  return {
    ...row,
    provider: row.provider as CodeRepoProvider,
    pullRequestState: row.pullRequestState === "merged" ? "merged" : "open",
  };
}

function inScope(scope: FindingScope) {
  return and(eq(f.orgId, scope.orgId), eq(f.workspaceId, scope.workspaceId));
}

function ofPullRequest(scope: FindingScope, pr: PullRequestKey) {
  return and(
    inScope(scope),
    eq(f.provider, pr.provider),
    eq(f.providerRepositoryId, pr.providerRepositoryId),
    eq(f.pullRequestNumber, pr.number),
  );
}

const heads = schema.repositoryBindingHeads;
const bindings = schema.repositoryBindings;
const proposals = schema.contextProposals;

async function selectLinked(
  scope: FindingScope,
  publicId: string | null,
): Promise<LinkedFinding[]> {
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        ...storedColumns,
        repositoryId: bindings.publicId,
        proposalStatus: proposals.status,
      })
      .from(f)
      .innerJoin(
        heads,
        and(
          eq(heads.orgId, f.orgId),
          eq(heads.workspaceId, f.workspaceId),
          eq(heads.provider, f.provider),
          eq(heads.providerRepositoryId, f.providerRepositoryId),
          eq(heads.role, "linked"),
        ),
      )
      .innerJoin(bindings, eq(bindings.id, heads.currentBindingId))
      .leftJoin(
        proposals,
        and(
          eq(proposals.orgId, f.orgId),
          eq(proposals.workspaceId, f.workspaceId),
          eq(proposals.publicId, f.proposalPublicId),
        ),
      )
      .where(publicId === null ? inScope(scope) : and(inScope(scope), eq(f.publicId, publicId)))
      .orderBy(asc(f.repository), asc(f.path), asc(f.line), asc(f.pullRequestNumber))
      .limit(FINDINGS_READ_MAX),
  );
  // A workspace can link one repository through two connections. Each row
  // is listed once.
  const seen = new Set<string>();
  const linked: LinkedFinding[] = [];
  for (const row of rows) {
    if (seen.has(row.publicId)) continue;
    seen.add(row.publicId);
    linked.push({
      ...stored(row),
      repositoryId: row.repositoryId,
      proposalStatus: row.proposalStatus ?? null,
    });
  }
  return linked;
}

export const postgresCodeRepoFindingStore: CodeRepoFindingStore = {
  async replacePullRequest(scope, pr, statements, at) {
    await withTenantDb(async (tx) => {
      const prior = await tx
        .select({
          publicId: f.publicId,
          path: f.path,
          statement: f.statement,
          proposalPublicId: f.proposalPublicId,
          createdAt: f.createdAt,
        })
        .from(f)
        .where(ofPullRequest(scope, pr));
      const held = new Map(prior.map((row) => [statementKey(row.path, row.statement), row]));
      await tx.delete(f).where(ofPullRequest(scope, pr));
      const lines = new Set<string>();
      const rows: (typeof f.$inferInsert)[] = [];
      for (const statement of statements) {
        // Two statements cannot start on one line of one file.
        const place = JSON.stringify([statement.path, statement.line]);
        if (lines.has(place)) continue;
        lines.add(place);
        const key = statementKey(statement.path, statement.text);
        const before = held.get(key);
        // The same text twice in one file keeps the old row once.
        held.delete(key);
        rows.push({
          publicId: before?.publicId ?? newFindingId(),
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          provider: pr.provider,
          providerRepositoryId: pr.providerRepositoryId,
          repository: pr.repository,
          pullRequestNumber: pr.number,
          pullRequestUrl: pr.url,
          pullRequestState: "open",
          headSha: pr.headSha,
          path: statement.path,
          line: statement.line,
          statement: statement.text,
          proposalPublicId: before?.proposalPublicId ?? null,
          checkedAt: at,
          createdAt: before?.createdAt ?? at,
        });
      }
      if (rows.length > 0) await tx.insert(f).values(rows).onConflictDoNothing();
    });
  },

  async clearPullRequest(scope, pr) {
    const gone = await withTenantDb((tx) =>
      tx.delete(f).where(ofPullRequest(scope, pr)).returning({ id: f.id }),
    );
    return gone.length;
  },

  async markMerged(scope, pr, headSha) {
    await withTenantDb((tx) =>
      tx
        .update(f)
        .set({ pullRequestState: "merged", headSha })
        .where(ofPullRequest(scope, pr)),
    );
  },

  async mergedElsewhere(scope, pr) {
    const rows = await withTenantDb((tx) =>
      tx
        .select(storedColumns)
        .from(f)
        .where(
          and(
            inScope(scope),
            eq(f.provider, pr.provider),
            eq(f.providerRepositoryId, pr.providerRepositoryId),
            ne(f.pullRequestNumber, pr.number),
            eq(f.pullRequestState, "merged"),
          ),
        ),
    );
    return rows.map(stored);
  },

  async remove(scope, publicIds) {
    if (publicIds.length === 0) return;
    await withTenantDb((tx) =>
      tx.delete(f).where(and(inScope(scope), inArray(f.publicId, [...publicIds]))),
    );
  },

  listLinked: (scope) => selectLinked(scope, null),

  async findLinked(scope, publicId) {
    const [row] = await selectLinked(scope, publicId);
    return row ?? null;
  },

  async setProposal(scope, publicId, proposalPublicId) {
    await withTenantDb((tx) =>
      tx
        .update(f)
        .set({ proposalPublicId })
        .where(and(inScope(scope), eq(f.publicId, publicId))),
    );
  },
};
