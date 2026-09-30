import { z } from "zod";
import { registerCapability } from "../registry";
import { skillCandidateSchema } from "../skills";

/**
 * The person's read of skill resolution. It names every withheld skill, which is
 * the projection the withholding mechanism exists to keep from an agent, so the
 * capability declares no MCP surface: the kernel refuses the dispatch before a
 * handler runs, rather than a branch inside one deciding who sees a name.
 * `summarize_skill_search` is the agent's counts-only read of the same resolution
 * (ADR-090, apps/app/ARCHITECTURE.md §1.2 Skills, #3669).
 */
export const skillSearchPreview = registerCapability({
  name: "preview_skill_search",
  domain: "skill",
  mode: "sync",
  description:
    "Preview approved skill resolution at a published configuration version. Shows a person withheld names and reasons without loading skills into a run.",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs", "app"],
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
        z.object({
          id: skillCandidateSchema.shape.id,
          reason: z.enum(["out_of_scope", "unapproved_digest"]),
        }),
      ),
      tokenCost: z.number().int().nonnegative(),
    })
    .strict(),
});
