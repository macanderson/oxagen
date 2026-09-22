import { z } from "zod";
import { registerCapability } from "../registry";
import { skillCandidateSchema } from "../skills";

/**
 * The agent's read of the same resolution `preview_skill_search` answers for a
 * person. A withheld skill has no place to go in this output: the schema carries
 * a count and a reason class and no identifier, so no branch inside a handler
 * decides whether a name reaches an agent (ADR-090, #3669).
 */
export const skillSearchSummarize = registerCapability({
  name: "summarize_skill_search",
  domain: "skill",
  mode: "sync",
  description:
    "Summarize approved skill resolution at a published configuration version. Returns the skills an agent may load and counts the withheld ones by reason, never their names.",
  surfaces: ["mcp"],
  layers: ["schema", "mcp", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      version: z.string().min(1).max(128),
      query: z.string().min(1).max(2000),
    })
    .strict(),
  output: z
    .object({
      version: z.string(),
      repositoryCommitSha: z.string(),
      results: z.array(
        skillCandidateSchema.extend({ score: z.number().min(0).max(1) }),
      ),
      withheld: z
        .object({
          count: z.number().int().nonnegative(),
          reasons: z
            .object({
              out_of_scope: z.number().int().nonnegative(),
              unapproved_digest: z.number().int().nonnegative(),
            })
            .strict(),
        })
        .strict(),
      tokenCost: z.number().int().nonnegative(),
    })
    .strict(),
});

export type SkillSearchSummarizeInput = z.output<
  typeof skillSearchSummarize.input
>;
export type SkillSearchSummarizeOutput = z.output<
  typeof skillSearchSummarize.output
>;
