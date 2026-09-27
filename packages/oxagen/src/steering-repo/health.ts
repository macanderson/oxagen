// health.ts: a steering repo's health (steering-repo-spec, Settings drift).
// While health is not `healthy`, Oxagen merges nothing and publishes nothing,
// and runs keep the last published version.
import { z } from "zod";
import { instantSchema } from "./common";

export const REPO_HEALTH_STATES = [
  "healthy",
  "drifted",
  "disconnected",
  "diverged",
] as const;

/**
 * - `healthy`: the settings match.
 * - `drifted`: a setting differs and Oxagen can still write settings.
 * - `disconnected`: Oxagen lost access to the repository.
 * - `diverged`: `main` holds a commit Oxagen did not merge.
 */
export const repoHealthSchema = z.enum(REPO_HEALTH_STATES);
export type RepoHealth = z.output<typeof repoHealthSchema>;

/** One prescribed setting that differs, as the failed check and the banner list it. */
export const settingsDifferenceSchema = z
  .object({
    setting: z
      .string()
      .min(1)
      .describe("The setting's path in the baseline, such as rulesets.oxagen_merges."),
    expected: z.unknown(),
    actual: z.unknown(),
    changed_by: z.string().nullable(),
    changed_at: instantSchema.nullable(),
  })
  .strict();
export type SettingsDifference = z.output<typeof settingsDifferenceSchema>;
