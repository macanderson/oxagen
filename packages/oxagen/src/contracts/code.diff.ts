import { z } from "zod";
import { registerCapability } from "../registry";

// Upper bound on each blob fed to the differ. A unified diff is computed in
// memory, so an unbounded input is a memory-exhaustion vector; 1 MiB per side
// comfortably covers source files while capping the blast radius.
const MAX_BLOB_BYTES = 1024 * 1024; // 1 MiB

export const codeDiff = registerCapability({
  name: "diff_code",
  domain: "code",
  description:
    "Produce a unified diff between two file blobs (before vs after), with " +
    "added/removed line counts. Pure text computation — no sandbox required.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "code" },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    before: z
      .string()
      .max(MAX_BLOB_BYTES)
      .describe("Original file contents (the 'a' side of the diff)"),
    after: z
      .string()
      .max(MAX_BLOB_BYTES)
      .describe("New file contents (the 'b' side of the diff)"),
    path: z
      .string()
      .min(1)
      .max(255)
      .default("file")
      .describe("File path used in the diff's ---/+++ headers"),
    contextLines: z
      .number()
      .int()
      .min(0)
      .max(100)
      .default(3)
      .describe("Number of unchanged context lines around each hunk"),
  }),
  output: z.object({
    diff: z
      .string()
      .describe("Unified diff text; empty string when before === after"),
    changed: z.boolean().describe("True when the two blobs differ"),
    additions: z.number().int().describe("Count of added lines"),
    deletions: z.number().int().describe("Count of removed lines"),
  }),
});

export type CodeDiffInput = z.output<typeof codeDiff.input>;
export type CodeDiffOutput = z.output<typeof codeDiff.output>;
