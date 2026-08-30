import { applyPatch, parsePatch, type StructuredPatch } from "diff";
import { assertSafeWorkspacePath } from "@oxagen/sandbox/workspace";
import type { CapabilityContext } from "../types";
import type {
  CodePatchInput,
  CodePatchOutput,
  CodePatchFile,
} from "@oxagen/oxagen/contracts/code.patch";

export type { CodePatchInput, CodePatchOutput };

/** The unified-diff sentinel for "this side of the patch has no file". */
const DEV_NULL = "/dev/null";

/** Strip a leading git-style `a/` or `b/` prefix from a diff file header. */
function stripGitPrefix(name: string | undefined): string {
  if (!name) return "";
  const trimmed = name.trim();
  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) {
    return trimmed.slice(2);
  }
  return trimmed;
}

/** True when a diff header names /dev/null (an add on the old side, a delete on the new). */
function isDevNull(name: string | undefined): boolean {
  return (name ?? "").trim() === DEV_NULL;
}

/**
 * Apply a unified diff to a path-confined, in-memory workspace and return only
 * the changed files.
 *
 * Applied in-process, not in a sandbox: applying a unified diff is pure,
 * path-confined text manipulation with NO code execution. The security boundary
 * that matters here — path-traversal confinement, malformed-diff rejection, and
 * size caps — is enforced in-process; a sandbox isolates untrusted *execution*,
 * which patch application is not, so a container would only add attack surface
 * and latency. `jsdiff`'s `applyPatch` is the canonical applier and returns
 * `false` (never a partial write) when a hunk fails to apply cleanly.
 */
export async function codePatchHandler(
  input: CodePatchInput,
  _ctx: CapabilityContext,
): Promise<CodePatchOutput> {
  const { files, diff } = input;

  const patches: StructuredPatch[] = parsePatch(diff);
  if (patches.length === 0) {
    throw new Error("code.patch: no file patches found in the diff");
  }

  const changed: CodePatchFile[] = [];
  for (const patch of patches) {
    if (patch.hunks.length === 0) {
      throw new Error("code.patch: malformed diff — a file patch has no hunks");
    }

    const isAdd = isDevNull(patch.oldFileName);
    const isDelete = isDevNull(patch.newFileName);
    // For a delete the new side is /dev/null, so the real path is the old side.
    const targetPath = stripGitPrefix(
      isDelete ? patch.oldFileName : patch.newFileName,
    );

    // Path-traversal confinement: every target must resolve inside the
    // workspace root (throws SandboxWorkspaceError on `..`/absolute escapes).
    assertSafeWorkspacePath(targetPath);

    const source = isAdd ? "" : (files[targetPath] ?? "");
    const result = applyPatch(source, patch);
    if (result === false) {
      throw new Error(
        `code.patch: hunk failed to apply cleanly to "${targetPath}"`,
      );
    }

    if (isDelete) {
      changed.push({ path: targetPath, status: "deleted", content: "" });
    } else {
      const status: CodePatchFile["status"] =
        isAdd || !(targetPath in files) ? "added" : "modified";
      changed.push({ path: targetPath, status, content: result });
    }
  }

  return { applied: true, files: changed, changedCount: changed.length };
}
