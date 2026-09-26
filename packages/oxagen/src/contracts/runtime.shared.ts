// Shapes shared by the runtime contracts and every contract that names a
// runtime (ADR-198). No capability registers here.
import { z } from "zod";
import { WORKSPACE_SLUG_PATTERN } from "../workspace-slug";

/** The longest runtime slug (`agent.runtimes.slug`, `runtimes_slug_check`). */
export const RUNTIME_SLUG_MAX = 40;

export const runtimeSlugSchema = z
  .string()
  .min(1)
  .max(RUNTIME_SLUG_MAX)
  .regex(
    WORKSPACE_SLUG_PATTERN,
    "lowercase letters and digits, separated by single hyphens",
  );

/** `rtm_…`. */
export const runtimeIdSchema = z.string().regex(/^rtm_[0-9a-z]+$/);

/** A runtime as every other record names it. */
export const runtimeRefSchema = z
  .object({
    id: runtimeIdSchema,
    name: z.string().min(1),
    slug: z.string().min(1),
  })
  .strict();
export type RuntimeRef = z.output<typeof runtimeRefSchema>;

/**
 * The name → slug rule every runtime and agent slug is derived by, re-exported
 * so `apps/app` reaches it through `@oxagen/oxagen/contracts/*` (INV-03).
 */
export { slugFromName } from "../workspace-slug";
