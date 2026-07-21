/**
 * `:SourceFile` natural-key derivation — shared by the file-lock adapters
 * (`file-lock.ts`, `file-lock-lease.ts`) so a locked file and any other
 * graph-referenced file resolve to the SAME node identity.
 */

/**
 * Build the SourceFile naturalKey:
 *   `github:{owner}/{repo}:{path}` when GitHub coordinates are provided,
 *   otherwise the raw `path`.
 */
export function toNaturalKey(
  path: string,
  owner: string | undefined,
  repo: string | undefined,
): string {
  if (owner && repo) {
    // Normalise leading slash
    const normalPath = path.startsWith("/") ? path.slice(1) : path;
    return `github:${owner}/${repo}:${normalPath}`;
  }
  return path;
}
