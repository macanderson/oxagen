import { scopedSession } from "../tenant";
import {
  codeScopeNaturalKey,
  repositoryNaturalKey,
  repositorySnapshotNaturalKey,
  toNaturalKey,
} from "../natural-key";

// ── Workspace-graph snapshot projection ────────────────────────────────────
//
// Neo4j is a REBUILDABLE, RBAC-filtered projection of the Postgres canonical
// truth (docs/specs/workspace-graph-boundary/spec.md §"The three data planes").
// These mutations write ONLY governed topology — repository identity, the
// commit-addressed snapshot, and the minimal CodeScope graph — never symbols,
// chunks, lines, or plaintext/embeddings of source (those stay in Stella's
// local graph). Every write is idempotent (MERGE on a natural key) so a
// re-projection of the same snapshot is a no-op on identity.
//
// House style mirrors record-execution.ts / project-file-lock.ts: scopedSession()
// for the tenant seam (it injects $orgId + $workspaceId into every params
// object), the universal :GraphNode anchor + is_system co-label so nodes surface
// in the graph explorer, temporal props via datetime(), and UNWIND for batched
// writes.

export interface ProjectSnapshotScope {
  scopeKey: string;
  kind: string;
  displayName: string;
  /** Nullable inferred domain slug — no domains table at launch (spec §7). */
  domainSlug?: string | null;
  fileCount: number;
}

export interface ProjectSnapshotInput {
  repository: {
    /** Provider's IMMUTABLE repository id (GitHub numeric id as text). */
    providerRepoId: string;
    owner: string;
    name: string;
  };
  snapshot: {
    /** Immutable commit SHA observed at the canonical ref. */
    commitSha: string;
    treeSha: string;
  };
  scopes: ProjectSnapshotScope[];
}

/**
 * Project a completed canonical snapshot into the workspace graph:
 *   (:Repository)-[:HAS_SNAPSHOT]->(:RepositorySnapshot)-[:BINDS_SCOPE]->(:CodeScope)
 *
 * Repository identity is the provider's immutable id, snapshot identity is the
 * commit SHA — never the moving branch name (spec canonical-ref policy). Called
 * by the lifecycle driver AFTER the Postgres generation is complete, so the
 * graph only ever presents an activated projection.
 */
export async function projectSnapshotToGraph(
  input: ProjectSnapshotInput,
): Promise<void> {
  const { repository, snapshot, scopes } = input;

  const repositoryKey = repositoryNaturalKey(repository.providerRepoId);
  const snapshotKey = repositorySnapshotNaturalKey(
    repository.providerRepoId,
    snapshot.commitSha,
  );
  const displayName = `${repository.owner}/${repository.name}`;

  const neo4j = scopedSession();
  try {
    // Repository + snapshot spine. ON CREATE fixes immutable identity; the
    // trailing SET refreshes mutable display props on re-projection without
    // disturbing the HAS_SNAPSHOT edge.
    await neo4j.run(
      `MERGE (repo:Repository {naturalKey: $repositoryKey, orgId: $orgId})
       ON CREATE SET
         repo.publicId  = randomUUID(),
         repo.createdAt = datetime()
       SET
         repo:GraphNode,
         repo.is_system      = true,
         repo.label          = 'Repository',
         repo.provider       = 'github',
         repo.providerRepoId = $providerRepoId,
         repo.owner          = $owner,
         repo.name           = $name,
         repo.displayName    = $displayName,
         repo.updatedAt      = datetime()
       MERGE (snap:RepositorySnapshot {naturalKey: $snapshotKey, orgId: $orgId})
       ON CREATE SET
         snap.publicId  = randomUUID(),
         snap.createdAt = datetime()
       SET
         snap:GraphNode,
         snap.is_system   = true,
         snap.label       = 'RepositorySnapshot',
         snap.commitSha   = $commitSha,
         snap.treeSha     = $treeSha,
         snap.displayName = $snapshotDisplayName,
         snap.updatedAt   = datetime()
       MERGE (repo)-[hs:HAS_SNAPSHOT]->(snap)
       SET hs.is_system = true`,
      {
        repositoryKey,
        snapshotKey,
        providerRepoId: repository.providerRepoId,
        owner: repository.owner,
        name: repository.name,
        displayName,
        commitSha: snapshot.commitSha,
        treeSha: snapshot.treeSha,
        snapshotDisplayName: `${displayName}@${snapshot.commitSha.slice(0, 7)}`,
      },
    );

    // CodeScope topology bound to the snapshot. UNWIND collapses all scope
    // MERGEs into one round-trip. Each scope's naturalKey is precomputed so it
    // is byte-identical to the per-file projector's IN_SCOPE target.
    if (scopes.length > 0) {
      const scopeRows = scopes.map((s) => ({
        naturalKey: codeScopeNaturalKey(
          repository.owner,
          repository.name,
          s.scopeKey,
        ),
        scopeKey: s.scopeKey,
        kind: s.kind,
        displayName: s.displayName,
        domainSlug: s.domainSlug ?? null,
        fileCount: s.fileCount,
      }));

      await neo4j.run(
        `MATCH (snap:RepositorySnapshot {naturalKey: $snapshotKey, orgId: $orgId})
         UNWIND $scopes AS scope
         MERGE (cs:CodeScope {naturalKey: scope.naturalKey, orgId: $orgId})
         ON CREATE SET
           cs.publicId  = randomUUID(),
           cs.createdAt = datetime()
         SET
           cs:GraphNode,
           cs.is_system   = true,
           cs.label       = 'CodeScope',
           cs.scopeKey    = scope.scopeKey,
           cs.kind        = scope.kind,
           cs.displayName = scope.displayName,
           cs.domainSlug  = scope.domainSlug,
           cs.fileCount   = scope.fileCount,
           cs.commitSha   = $commitSha,
           cs.updatedAt   = datetime()
         MERGE (snap)-[bs:BINDS_SCOPE]->(cs)
         SET bs.is_system = true`,
        {
          snapshotKey,
          commitSha: snapshot.commitSha,
          scopes: scopeRows,
        },
      );
    }
  } finally {
    await neo4j.close();
  }
}

export interface RemoveCanonicalFilesInput {
  owner: string;
  repo: string;
  paths: string[];
}

/**
 * DETACH DELETE the canonical `:SourceFile` nodes for the given repo paths —
 * used when a canonical push deletes/renames files out of the snapshot. Keyed
 * on the unified `github:{owner}/{repo}:{path}` identity via toNaturalKey.
 * Batched UNWIND, tenant-scoped.
 */
export async function removeCanonicalFiles(
  input: RemoveCanonicalFilesInput,
): Promise<void> {
  const { owner, repo, paths } = input;
  if (paths.length === 0) return;
  const naturalKeys = paths.map((p) => toNaturalKey(p, owner, repo));

  const neo4j = scopedSession();
  try {
    await neo4j.run(
      `UNWIND $naturalKeys AS nk
       MATCH (f:SourceFile {naturalKey: nk, orgId: $orgId})
       DETACH DELETE f`,
      { naturalKeys },
    );
  } finally {
    await neo4j.close();
  }
}

export interface PruneLegacySourceDetailInput {
  owner: string;
  repo: string;
}

/**
 * Idempotent cleanup of the OLD workspace-graph source model for one repo,
 * within the tenant scope. Removes the detail the reshape deletes:
 *   - every `:SourceSymbol` / `:SourceChunk` node for this repo's files;
 *   - legacy `:SourceFile` nodes under the connectionId-prefixed key
 *     `github:{connectionId}:{owner}/{repo}:…`.
 *
 * The legacy SourceFile predicate is deliberately narrow: match the repo infix
 * `:{owner}/{repo}:` but EXCLUDE anything under the canonical prefix
 * `github:{owner}/{repo}:` — that NOT clause is what stops this from deleting
 * the canonical nodes the projector just wrote. The trailing colon on the infix
 * keeps `acme/api` from matching `acme/api-v2`.
 */
export async function pruneLegacySourceDetail(
  input: PruneLegacySourceDetailInput,
): Promise<void> {
  const { owner, repo } = input;
  const repoInfix = `:${owner}/${repo}:`;
  const canonicalPrefix = `github:${owner}/${repo}:`;

  const neo4j = scopedSession();
  try {
    // Symbols + chunks are gone from the new model entirely — any that exist
    // for this repo are legacy. Keyed by the repo infix on their naturalKey.
    await neo4j.run(
      `MATCH (s:SourceSymbol {orgId: $orgId})
       WHERE s.naturalKey CONTAINS $repoInfix
       DETACH DELETE s`,
      { repoInfix },
    );
    await neo4j.run(
      `MATCH (c:SourceChunk {orgId: $orgId})
       WHERE c.naturalKey CONTAINS $repoInfix
       DETACH DELETE c`,
      { repoInfix },
    );
    // Legacy connectionId-prefixed SourceFile nodes only — never the canonical
    // ones (guarded by the NOT STARTS WITH canonicalPrefix clause).
    await neo4j.run(
      `MATCH (f:SourceFile {orgId: $orgId})
       WHERE f.naturalKey STARTS WITH 'github:'
         AND f.naturalKey CONTAINS $repoInfix
         AND NOT f.naturalKey STARTS WITH $canonicalPrefix
       DETACH DELETE f`,
      { repoInfix, canonicalPrefix },
    );
  } finally {
    await neo4j.close();
  }
}
