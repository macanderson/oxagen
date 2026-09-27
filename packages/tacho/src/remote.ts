/**
 * How a git remote is reduced to the repository it names, before it is
 * digested.
 *
 * The host digests `git remote get-url origin` (`collector/git-facts.ts`),
 * and the control plane digests the repositories a workspace bound, to tell
 * whether a session runs in one of them. Both sides must reduce a remote the
 * same way, so the rule lives here, in a leaf module with no imports. The
 * control plane imports it from the package root and pulls in none of the
 * daemon.
 */

/**
 * The remote URL reduced to the repository it names, so two hosts working
 * the same repository digest to the same value.
 *
 * The digest exists to tell repositories apart without saying which one, so
 * it has to depend on the repository and nothing else. A remote often
 * carries per-machine credentials in its userinfo
 * (`https://user:token@host/acme/repo.git`), and hashing that raw made the
 * identity depend on the token: two developers, or one developer after a
 * rotation, produced different digests for the same repository and nothing
 * downstream could correlate them.
 *
 * So the userinfo, the query, and the fragment go, the scheme and the `.git`
 * suffix go, `scp` syntax (`git@host:acme/repo.git`) is folded onto the same
 * shape as its URL form, and the host is lowercased. The path is not, because a repository name is
 * case sensitive on most forges. None of this is reversible and none of it
 * needs to be: nothing reads the digest back, it is only compared.
 */
export function canonicalRemote(remote: string): string {
  let value = remote.trim();
  // `git@host:acme/repo.git` is the same repository as
  // `ssh://git@host/acme/repo.git`.
  const scp = /^([^/@]+)@([^/:]+):(.+)$/.exec(value);
  if (scp !== null && !value.includes("://"))
    value = `ssh://${scp[2] ?? ""}/${scp[3] ?? ""}`;
  value = value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  // Userinfo, which is where a token rides.
  const at = value.indexOf("@");
  const firstSlash = value.indexOf("/");
  if (at !== -1 && (firstSlash === -1 || at < firstSlash))
    value = value.slice(at + 1);
  // The query and the fragment, which is where the other kind of token rides
  // (`https://host/acme/repo.git?access_token=...`). Left on, the token
  // changed the digest on every rotation, and the `.git` suffix was no longer
  // at the end for the line below to find.
  value = value.replace(/[?#].*$/, "");
  // Trailing slashes first: the `.git` anchor does not match with one after
  // it, so the other order left `repo.git/` carrying its suffix.
  value = value.replace(/\/+$/, "").replace(/\.git$/, "");
  const slash = value.indexOf("/");
  if (slash === -1) return value.toLowerCase();
  return `${value.slice(0, slash).toLowerCase()}${value.slice(slash)}`;
}

/**
 * The forges that resolve a repository path without regard to case. On these
 * hosts `Acme/Repo` and `acme/repo` open the same repository.
 */
const CASE_INSENSITIVE_FORGES: ReadonlySet<string> = new Set([
  "github.com",
  "gitlab.com",
]);

/**
 * A canonical remote with its path lowercased, on a forge that ignores case
 * in a repository path. Any other host keeps the canonical form unchanged.
 *
 * `canonicalRemote` keeps the path's case, because most forges treat it as
 * significant. A remote typed as `github.com/Acme/Repo` and a binding stored
 * as `github.com/acme/repo` then digest apart, although GitHub serves both
 * from one repository. The folded form is a second digest both sides compute,
 * so such a pair still matches. Pass the output of `canonicalRemote`.
 */
export function foldedRemote(canonical: string): string {
  const slash = canonical.indexOf("/");
  if (slash === -1) return canonical;
  return CASE_INSENSITIVE_FORGES.has(canonical.slice(0, slash))
    ? canonical.toLowerCase()
    : canonical;
}
