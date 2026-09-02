import { z } from "zod";
import { registerCapability } from "../registry";
import { workspaceFilesSchema } from "./agent.code.execute";

// Upper bound on the unified-diff payload. Applying a diff is in-memory text
// manipulation, so an unbounded diff is a memory/CPU exhaustion vector. 2 MiB
// covers large multi-file patches while capping the blast radius.
const MAX_DIFF_BYTES = 2 * 1024 * 1024; // 2 MiB

/** Per-file outcome of applying a unified diff to the workspace. */
export const codePatchFileSchema = z.object({
  path: z.string().describe("Workspace-relative path of the changed file"),
  status: z
    .enum(["added", "modified", "deleted"])
    .describe("How the patch changed this file"),
  content: z
    .string()
    .describe(
      "New file contents after the patch (empty string for a deletion)",
    ),
});

export const codePatch = registerCapability({
  name: "patch_code",
  domain: "code",
  description:
    "Apply a unified diff to an in-memory, path-confined workspace (path → " +
    "contents) and return only the changed files. Rejects diffs that target " +
    "paths outside the workspace or fail to apply cleanly.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "medium", category: "code" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    files: workspaceFilesSchema.describe(
      "The workspace the diff applies against (path → contents). Paths are " +
        "confined to the workspace root; capped at 64 files / 5 MiB total.",
    ),
    diff: z
      .string()
      .min(1)
      .max(MAX_DIFF_BYTES)
      .describe("Unified diff to apply (may span multiple files)"),
  }),
  output: z.object({
    applied: z.boolean().describe("True when every hunk applied cleanly"),
    files: z
      .array(codePatchFileSchema)
      .describe(
        "Only the files the diff changed (added, modified, or deleted)",
      ),
    changedCount: z.number().int().describe("Number of changed files"),
  }),
});

export type CodePatchFile = z.output<typeof codePatchFileSchema>;
export type CodePatchInput = z.output<typeof codePatch.input>;
export type CodePatchOutput = z.output<typeof codePatch.output>;
