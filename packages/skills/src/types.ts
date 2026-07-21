import { z } from "zod";

// SkillFrontmatter is the compatibility projection consumed by existing
// callers after a canonical `skill.toml` has been validated. Metadata is an
// open bag the loader passes through so
// callers can read arbitrary keys without changing the parser contract.
export const skillFrontmatterSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, "kebab-case-slug only"),
  description: z.string().min(1),
  metadata: z
    .object({
      weight: z.enum(["low", "high", "critical"]).optional(),
      category: z.string().optional(),
    })
    .passthrough()
    .optional(),
});

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

export interface SkillReference {
  path: string;
  // Body is loaded lazily by the loader's reference resolver.
  body: string;
}

export interface Skill {
  slug: string;
  name: string;
  description: string;
  metadata: SkillFrontmatter["metadata"];
  body: string;
  // Explicit manifest references; bodies populate on demand.
  references: SkillReference[];
  source: "builtin" | "tenant";
  version: string;
}

// dbAdapter shape: handlers pass a thin async function that returns
// tenant-defined skills sourced from `workflow.prompt_templates`. The
// registry merges the result with filesystem skills. Kept as a function
// so the skills package never depends on Drizzle or Postgres directly.
export type SkillDbAdapter = () => Promise<Skill[]>;
