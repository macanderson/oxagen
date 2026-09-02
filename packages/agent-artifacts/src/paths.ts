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
 * - A reference that does not exist yet cannot be resolved, so it is returned
 *   after the lexical check alone. If an intermediate directory is a symlink
 *   pointing outside the bundle, a *write* to that path would land outside it.
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

  try {
    const [actualRoot, actualCandidate] = await Promise.all([
      realpath(lexicalRoot),
      realpath(lexicalCandidate),
    ]);
    if (!isContained(actualRoot, actualCandidate)) {
      throw new AgentArtifactError(
        "invalid_reference_path",
        `reference resolves outside artifact directory: ${reference}`,
      );
    }
    return lexicalCandidate;
  } catch (error) {
    if (error instanceof AgentArtifactError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    // Nothing on disk to resolve — a reference to a file the bundle declares
    // but has not written yet. The lexical check above is all the containment
    // proof available; see the TOCTOU/write caveat on this function.
    if (code === "ENOENT") return lexicalCandidate;
    throw new AgentArtifactError(
      "invalid_reference_path",
      `reference could not be resolved: ${reference}`,
      { cause: error },
    );
  }
}
