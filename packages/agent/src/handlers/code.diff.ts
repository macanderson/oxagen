import { createTwoFilesPatch, diffLines } from "diff";
import type { CapabilityContext } from "../types";
import type {
  CodeDiffInput,
  CodeDiffOutput,
} from "@oxagen/oxagen/contracts/code.diff";

export type { CodeDiffInput, CodeDiffOutput };

/**
 * Produce a unified diff between two blobs.
 *
 * Computed in-process, not in a sandbox: a unified diff is a deterministic
 * function of two strings with NO code execution, so isolating it in a
 * container would add latency and attack surface for zero benefit (the ticket
 * explicitly allows computing diffs in-process). We use `jsdiff` — the
 * canonical, well-tested unified-diff implementation — rather than hand-rolling
 * a Myers diff. Input size is bounded by the contract (1 MiB per side).
 */
export async function codeDiffHandler(
  input: CodeDiffInput,
  _ctx: CapabilityContext,
): Promise<CodeDiffOutput> {
  const { before, after, path, contextLines } = input;

  if (before === after) {
    return { diff: "", changed: false, additions: 0, deletions: 0 };
  }

  const diff = createTwoFilesPatch(
    `a/${path}`,
    `b/${path}`,
    before,
    after,
    "",
    "",
    { context: contextLines },
  );

  let additions = 0;
  let deletions = 0;
  for (const part of diffLines(before, after)) {
    if (part.added) additions += part.count ?? 0;
    else if (part.removed) deletions += part.count ?? 0;
  }

  return { diff, changed: true, additions, deletions };
}
