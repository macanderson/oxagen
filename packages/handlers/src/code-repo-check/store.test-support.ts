// code-repo-check/store.test-support.ts: agent.code_repository_findings in
// memory, for the check's, the read's, and promote's tests. It keeps rows the
// way store.ts does: a check replaces its pull request's rows and keeps the
// id and proposal of a statement it finds again, and the linked reads join
// the workspace's linked repositories and its proposals' statuses.
import type {
  CodeRepoFindingStore,
  FindingScope,
  LinkedFinding,
  PullRequestKey,
  StoredFinding,
} from "./store";

interface Row extends StoredFinding {
  orgId: string;
  workspaceId: string;
}

export interface MemoryFindingStore extends CodeRepoFindingStore {
  rows: Row[];
  /** The workspace's linked repositories: `<provider>:<repository id>` to the binding's id. */
  links: Map<string, string>;
  /** Each proposal's status, by its id. */
  proposals: Map<string, string>;
}

const sameScope = (row: Row, scope: FindingScope) =>
  row.orgId === scope.orgId && row.workspaceId === scope.workspaceId;

const samePullRequest = (row: Row, pr: PullRequestKey) =>
  row.provider === pr.provider &&
  row.providerRepositoryId === pr.providerRepositoryId &&
  row.pullRequestNumber === pr.number;

let counter = 0;

/** A row without its scope. */
function storedOf(row: Row): StoredFinding {
  return {
    publicId: row.publicId,
    provider: row.provider,
    providerRepositoryId: row.providerRepositoryId,
    repository: row.repository,
    pullRequestNumber: row.pullRequestNumber,
    pullRequestUrl: row.pullRequestUrl,
    pullRequestState: row.pullRequestState,
    headSha: row.headSha,
    path: row.path,
    line: row.line,
    statement: row.statement,
    proposalPublicId: row.proposalPublicId,
    checkedAt: row.checkedAt,
  };
}

export function memoryFindingStore(seed: Row[] = []): MemoryFindingStore {
  const store: MemoryFindingStore = {
    rows: [...seed],
    links: new Map(),
    proposals: new Map(),

    async replacePullRequest(scope, pr, statements, at) {
      const prior = store.rows.filter((row) => sameScope(row, scope) && samePullRequest(row, pr));
      store.rows = store.rows.filter((row) => !prior.includes(row));
      for (const statement of statements) {
        const index = prior.findIndex(
          (row) => row.path === statement.path && row.statement === statement.text,
        );
        const before = index >= 0 ? prior.splice(index, 1)[0] : undefined;
        counter += 1;
        store.rows.push({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          publicId: before?.publicId ?? `crf_mem${counter}`,
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
        });
      }
    },

    async clearPullRequest(scope, pr) {
      const before = store.rows.length;
      store.rows = store.rows.filter((row) => !(sameScope(row, scope) && samePullRequest(row, pr)));
      return before - store.rows.length;
    },

    async markMerged(scope, pr, headSha) {
      for (const row of store.rows)
        if (sameScope(row, scope) && samePullRequest(row, pr)) {
          row.pullRequestState = "merged";
          row.headSha = headSha;
        }
    },

    async mergedElsewhere(scope, pr) {
      return store.rows
        .filter(
          (row) =>
            sameScope(row, scope) &&
            row.provider === pr.provider &&
            row.providerRepositoryId === pr.providerRepositoryId &&
            row.pullRequestNumber !== pr.number &&
            row.pullRequestState === "merged",
        )
        .map(storedOf);
    },

    async remove(scope, publicIds) {
      store.rows = store.rows.filter(
        (row) => !(sameScope(row, scope) && publicIds.includes(row.publicId)),
      );
    },

    async listLinked(scope) {
      const linked: LinkedFinding[] = [];
      for (const row of store.rows) {
        if (!sameScope(row, scope)) continue;
        const repositoryId = store.links.get(`${row.provider}:${row.providerRepositoryId}`);
        if (repositoryId === undefined) continue;
        linked.push({
          ...storedOf(row),
          repositoryId,
          proposalStatus:
            row.proposalPublicId === null
              ? null
              : (store.proposals.get(row.proposalPublicId) ?? null),
        });
      }
      return linked.sort(
        (a, b) =>
          a.repository.localeCompare(b.repository) ||
          a.path.localeCompare(b.path) ||
          a.line - b.line,
      );
    },

    async findLinked(scope, publicId) {
      return (await store.listLinked(scope)).find((row) => row.publicId === publicId) ?? null;
    },

    async setProposal(scope, publicId, proposalPublicId) {
      for (const row of store.rows)
        if (sameScope(row, scope) && row.publicId === publicId)
          row.proposalPublicId = proposalPublicId;
    },
  };
  return store;
}
