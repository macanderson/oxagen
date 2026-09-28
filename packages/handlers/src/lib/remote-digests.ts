/**
 * The digests a Tacho host computes for a repository's remote, computed here
 * from a repository's name, so the control plane can match a repository the
 * host names only by digest.
 *
 * The host digests its `origin` remote twice: `canonicalRemote`, and
 * `foldedRemote` of that, which lowercases the path on a forge that ignores
 * its case (`collector/git-facts.ts` in `@oxagen/tacho`). The remote never
 * leaves the host. A bound repository's name (`boundRemoteDigests`), a
 * repository an interjection asks about (`repositoryDigests`), and a
 * steering record's `repos` entry (`recall_tacho_memories`) are all
 * `<host>/<owner>/<name>`, which `canonicalRemote` takes as it is, so one
 * rule digests all three.
 *
 * This module imports nothing but `@oxagen/tacho`, so recall can match
 * repositories without loading the database.
 */
import { canonicalRemote, digestBytes, foldedRemote } from "@oxagen/tacho";

/**
 * The canonical and folded digests of one remote, canonical first. The two
 * are the same digest when folding changes nothing, and then it is listed
 * once.
 */
export function remoteDigests(remote: string): string[] {
  const canonical = canonicalRemote(remote);
  const exact = digestBytes(canonical);
  const folded = digestBytes(foldedRemote(canonical));
  return folded === exact ? [exact] : [exact, folded];
}
