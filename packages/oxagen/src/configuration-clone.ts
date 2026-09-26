import { z } from "zod";

// An agent is not a configuration a clone copies: it is an identity on a
// runtime with a harness and a toolbelt (ADR-198). Skills and records are.
export const configurationKindSchema = z.enum(["skill", "record"]);
export type ConfigurationKind = z.infer<typeof configurationKindSchema>;
export const configurationCloneDraftSchema = z
  .object({
    kind: configurationKindSchema,
    sourceId: z.string().min(1).max(200),
    sourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    slug: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    source: z.string().min(1).max(65536),
    files: z
      .array(
        z
          .object({ path: z.string().max(200), content: z.string().max(65536) })
          .strict(),
      )
      .max(16),
  })
  .strict();
export type ConfigurationCloneDraft = z.infer<
  typeof configurationCloneDraftSchema
>;

/**
 * Fit the suffix inside the existing identifier limit without dropping the
 * suffix. `nameMaximum` caps the name the same way: a record's name is its
 * label, which is at most 36 characters (ADR-178).
 */
export function configurationCloneName(
  slug: string,
  name: string,
  ordinal: number,
  maximum: number,
  nameMaximum = 200,
) {
  const suffix = ordinal === 0 ? "-cloned" : `-cloned-${ordinal}`;
  const stem = slug.slice(0, maximum - suffix.length).replace(/[.-]+$/, "");
  if (!stem) throw new Error("The clone suffix leaves no identifier stem");
  return {
    slug: `${stem}${suffix}`,
    name: `${name.slice(0, nameMaximum - suffix.length).trimEnd()}${suffix}`,
  };
}
