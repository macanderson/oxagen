/**
 * Canonical Neo4j natural-key derivation for the workspace-graph code
 * projection. This is the ONE home for these keys — file-lock adapters, the
 * GitHub ingestion projector, record-execution lineage, and the snapshot
 * projector all derive identity here so a file reached via two connections, a
 * lock, and a run all resolve to the SAME node
 * (docs/specs/workspace-graph-boundary/spec.md finding 4, launch invariant 1).
 *
 * Pure string module — NO neo4j-driver / client imports — so it can be pulled
 * in via the lightweight `@oxagen/ontology/natural-key` subpath from a hot path
 * (the file-lock lease) without dragging the driver graph.
 *
 * Identity rule: a repository is identified by its provider coordinates, NEVER
 * by the connection that reached it (a repo reached via two connections is the
 * same repo), so connectionId is absent from every key below.
 */

/**
 * SourceFile natural key: `github:{owner}/{repo}:{path}` when GitHub
 * coordinates are provided, otherwise the raw `path`. Leading slashes on the
 * path are normalised so `/src/a.ts` and `src/a.ts` key the same node.
 */
export function toNaturalKey(
  path: string,
  owner: string | undefined,
  repo: string | undefined,
): string {
  if (owner && repo) {
    const normalPath = path.startsWith("/") ? path.slice(1) : path;
    return `github:${owner}/${repo}:${normalPath}`;
  }
  return path;
}

/**
 * CodeScope natural key: `github:{owner}/{repo}:scope:{scopeKey}`. Shared by
 * the snapshot projector (which MERGEs the scope node) and the per-file
 * projector (which MERGEs the IN_SCOPE edge target) so both land on the same
 * node.
 */
export function codeScopeNaturalKey(
  owner: string,
  repo: string,
  scopeKey: string,
): string {
  return `github:${owner}/${repo}:scope:${scopeKey}`;
}

/**
 * Repository natural key: `github:repo:{providerRepoId}`. Keyed on the
 * provider's IMMUTABLE repository id (GitHub's numeric id), never owner/name
 * (which can be renamed under you) — spec canonical-ref policy.
 */
export function repositoryNaturalKey(providerRepoId: string): string {
  return `github:repo:${providerRepoId}`;
}

/**
 * RepositorySnapshot natural key:
 * `github:repo:{providerRepoId}:snapshot:{commitSha}`. One immutable snapshot
 * per (repository, canonical commit).
 */
export function repositorySnapshotNaturalKey(
  providerRepoId: string,
  commitSha: string,
): string {
  return `github:repo:${providerRepoId}:snapshot:${commitSha}`;
}
