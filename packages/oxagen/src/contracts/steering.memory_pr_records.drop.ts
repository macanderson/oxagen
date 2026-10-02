/**
 * drop_memory_record: take one proposed steering record out of an open
 * memory PR (#4518; ADR-206 decision 7, as ADR-248 amends it).
 *
 * The handler pushes one commit to the memory PR's branch that deletes the
 * record's file. Nothing else changes until the PR settles. When the PR
 * merges, the curator settles it: a proposed record whose file is not at the
 * merge commit did not merge, so its statements are rejected and its
 * memories wait again (packages/handlers/src/memory/settle.ts). A record the
 * branch no longer holds is answered with the commit that removed it.
 *
 * The PR is named by its number, as list_memory_pr_records names it.
 * Refused for a number that names no memory PR, a merged or closed memory PR,
 * a path the PR does not propose, and the PR's last record: closing the PR
 * rejects every record instead.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

export const steeringMemoryPrRecordDrop = registerCapability({
  name: "drop_memory_record",
  domain: "context",
  description:
    "Drop one proposed steering record from an open memory PR: pushes a commit to the PR's branch that deletes the record's file. When the PR merges, its settlement rejects the dropped record's statements and its memories wait again. Refused for a merged or closed PR, a path the PR does not propose, and the PR's last record.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "cli", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      number: z
        .number()
        .int()
        .positive()
        .describe("The memory PR's number in its steering repository."),
      path: z
        .string()
        .min(1)
        .max(512)
        .describe(
          "The record file to drop, as list_memory_pr_records names it, such as steering/memory/workspace/general/<lineage>.md.",
        ),
    })
    .strict(),
  output: z
    .object({
      pull_request: z
        .object({
          number: z.number().int().positive(),
          url: z.string(),
          branch: z.string(),
        })
        .strict(),
      path: z.string(),
      lineage: z.string(),
      /** The commit on the branch that deleted the record's file. */
      commit_sha: z.string(),
      /** True when the file was already gone, and `commit_sha` is the commit that removed it. */
      already_dropped: z.boolean(),
    })
    .strict(),
});

export type SteeringMemoryPrRecordDropInput = z.output<
  typeof steeringMemoryPrRecordDrop.input
>;
export type SteeringMemoryPrRecordDropOutput = z.output<
  typeof steeringMemoryPrRecordDrop.output
>;
