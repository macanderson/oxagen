import { z } from "zod";
import { LEGACY_SKILLS_DIR } from "./steering-repo/paths";

export const skillPinSchema = z
  .object({
    id: z
      .string()
      .max(48)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

export const skillConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    enabled: z.boolean().default(false),
    sources: z
      .array(
        z
          .object({
            id: z
              .string()
              .max(48)
              .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
            path: z.literal(LEGACY_SKILLS_DIR),
            skills: z.array(skillPinSchema).max(1000).default([]),
          })
          .strict(),
      )
      .max(1)
      .default([]),
    search: z
      .object({
        mode: z.literal("on_demand").default("on_demand"),
        cutoff: z.number().min(0).max(1).default(0),
        budget: z.number().int().min(0).max(100_000).default(6000),
        limit: z.number().int().min(1).max(100).default(10),
      })
      .strict()
      .default({}),
    unbound_repo: z.literal("ask").default("ask"),
    reflection: z
      .object({
        enabled: z.boolean().default(false),
        use: z.literal("research").default("research"),
        retention_days: z.number().int().min(1).max(90).default(30),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((config, ctx) => {
    const sources = new Set<string>();
    for (const source of config.sources) {
      if (sources.has(source.id))
        ctx.addIssue({ code: "custom", message: "Source ids must be unique" });
      sources.add(source.id);
      const pins = new Set<string>();
      for (const pin of source.skills) {
        const key = `${pin.id}@${pin.version}`;
        if (pins.has(key))
          ctx.addIssue({
            code: "custom",
            message: "A source may pin each skill version once",
          });
        pins.add(key);
      }
    }
  });

export type SkillConfig = z.output<typeof skillConfigSchema>;
export const SKILL_INTERJECTION_TIMEOUT_MS = 30 * 60 * 1000;

export const skillCandidateSchema = skillPinSchema.extend({
  source: z.string().min(1).max(48),
  description: z.string().max(8000),
  tokenCost: z.number().int().nonnegative().max(1_000_000),
});
export type SkillCandidate = z.output<typeof skillCandidateSchema>;
export type SkillWithheldReason = "out_of_scope" | "unapproved_digest";

export const publishedSkillConfigSchema = z
  .object({
    id: z
      .string()
      .max(48)
      .regex(/^skv_[a-z0-9]+$/),
    version: z.string().regex(/^skl_v\d+$/),
    commitSha: z.string(),
    pullRequestNumber: z.number().int().positive().nullable(),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    config: skillConfigSchema,
    publishedAt: z.string().datetime(),
    /**
     * True when the version was published under the repository binding the
     * workspace holds now. `preview_skill_search` refuses any other version
     * with `skill_repository_changed`, so a client offers only these for a
     * preview. `get_skill_config` sets it on every row. A publication result
     * omits it.
     */
    searchable: z.boolean().optional(),
  })
  .strict();
