import { z } from "zod";
import { registerCapability } from "../registry";
import { skillCandidateSchema } from "../skills";

export const skillSearchPreview = registerCapability({
  name: "preview_skill_search",
  domain: "skill",
  mode: "sync",
  description:
    "Preview approved skill resolution at a published configuration version. Shows a person withheld names and reasons without loading skills into a run.",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
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
      withheld: z.array(
        skillCandidateSchema.extend({
          reason: z.enum(["out_of_scope", "unapproved_digest"]),
        }),
      ),
      tokenCost: z.number().int().nonnegative(),
    })
    .strict(),
});
