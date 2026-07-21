/**
 * Build the stable repository-scoped key used by file-lock leases.
 *
 * Repository coordinates avoid collisions between identical relative paths in
 * different repositories. Callers without coordinates retain the path as-is.
 */
export function toFileResourceKey(
  path: string,
  owner: string | undefined,
  repo: string | undefined,
): string {
  if (owner && repo) {
    const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
    return `github:${owner}/${repo}:${normalizedPath}`;
  }
  return path;
}
