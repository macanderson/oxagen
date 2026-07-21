import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { AgentArtifactError } from "./errors";

function isContained(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

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
    if (code === "ENOENT") return lexicalCandidate;
    throw new AgentArtifactError(
      "invalid_reference_path",
      `reference could not be resolved: ${reference}`,
      { cause: error },
    );
  }
}
