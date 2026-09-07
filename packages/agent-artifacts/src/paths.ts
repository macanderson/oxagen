import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { AgentArtifactError } from "./errors";

/** True when `candidate` is `root` itself or sits somewhere beneath it. */
function isContained(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

/**
 * The deepest ancestor of `candidate` that exists on disk, with the part of the
 * path that does not exist yet.
 *
 * A path about to be written has nothing at its own location to resolve, but
 * the directory it will be created in usually does, and that directory is where
 * a symlink out of the bundle would sit. Walking up finds it. The walk stops at
 * `root` and returns null if it gets there without finding anything, which
 * means nothing under `root` exists to be a symlink at all.
 */
async function deepestExisting(
  root: string,
  candidate: string,
): Promise<{ resolved: string; missing: string } | null> {
  let current = candidate;
  for (;;) {
    try {
      return {
        resolved: await realpath(current),
        missing: relative(current, candidate),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current || !isContained(root, parent)) return null;
    current = parent;
  }
}

/**
 * Turns a sidecar reference from an artifact into an absolute path, proving
 * along the way that it stays inside the artifact's own directory.
 *
 * Two checks run. The first is lexical and rejects absolute paths and `..`
 * traversal. The second resolves symlinks on both the directory and the target
 * and re-checks containment, which is what catches a reference that looks
 * innocent but points at a link out of the bundle.
 *
 * Callers must treat the result as a *read* path only. Two limits matter:
 *
 * - The returned path is the lexical one, not the resolved one, so a symlink
 *   swapped between this call and the open is not covered (TOCTOU).
 *
 * A reference that does not exist yet is still checked. Its own location has
 * nothing to resolve, so the deepest ancestor that does exist is resolved
 * instead and the missing remainder projected onto it. That is what catches an
 * intermediate directory that is a symlink out of the bundle, which a write to
 * the returned path would otherwise follow (#1429).
 *
 * Callers must still treat the result as a read path: see the TOCTOU limit
 * above, which the ancestor check does not close.
 *
 * @param ownerFile Absolute path of the artifact file holding the reference;
 * its directory is the containment root.
 * @param reference The relative path as written in the artifact.
 * @throws {AgentArtifactError} `invalid_reference_path` on any escape.
 */
export async function resolveContainedPath(
  ownerFile: string,
  reference: string,
): Promise<string> {
  if (
    reference.length === 0 ||
    isAbsolute(reference) ||
    reference.replaceAll("\\", "/").split("/").includes("..")
  ) {
    throw new AgentArtifactError(
      "invalid_reference_path",
      `reference must be relative and contained: ${reference}`,
    );
  }

  const lexicalRoot = resolve(dirname(ownerFile));
  const lexicalCandidate = resolve(lexicalRoot, reference);
  if (!isContained(lexicalRoot, lexicalCandidate)) {
    throw new AgentArtifactError(
      "invalid_reference_path",
      `reference escapes artifact directory: ${reference}`,
    );
  }

  const escaped = () =>
    new AgentArtifactError(
      "invalid_reference_path",
      `reference resolves outside artifact directory: ${reference}`,
    );

  try {
    // The root is resolved first, alone. Resolving both together made an ENOENT
    // ambiguous: a missing root and a missing target arrive as the same error
    // and want opposite answers.
    let actualRoot: string;
    try {
      actualRoot = await realpath(lexicalRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // The bundle directory itself does not exist, so no symlink exists
      // anywhere beneath it and the lexical check is the whole proof.
      return lexicalCandidate;
    }

    try {
      if (!isContained(actualRoot, await realpath(lexicalCandidate))) {
        throw escaped();
      }
      return lexicalCandidate;
    } catch (error) {
      if (error instanceof AgentArtifactError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    // The target does not exist yet, which is every file about to be written.
    // Its deepest existing ancestor is resolved instead, and the remainder --
    // which cannot contain a symlink, because none of it is on disk -- is
    // projected onto the result.
    const found = await deepestExisting(lexicalRoot, lexicalCandidate);
    if (!found) return lexicalCandidate;
    const projected =
      found.missing === ""
        ? found.resolved
        : resolve(found.resolved, found.missing);
    if (!isContained(actualRoot, projected)) throw escaped();
    return lexicalCandidate;
  } catch (error) {
    if (error instanceof AgentArtifactError) throw error;
    throw new AgentArtifactError(
      "invalid_reference_path",
      `reference could not be resolved: ${reference}`,
      { cause: error },
    );
  }
}
