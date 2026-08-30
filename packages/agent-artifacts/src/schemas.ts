import { z } from "zod";
import { agentDriverSchema } from "./lifecycle";
import { CAPABILITY_SLUG_PATTERN, KEBAB_SLUG_PATTERN } from "./slugs";

const artifactNameSchema = z
  .string()
  .min(1)
  .regex(KEBAB_SLUG_PATTERN, "must be a kebab-case artifact slug");

/** Name of an Oxagen capability or core tool an agent is allowed to call. */
export const capabilitySlugSchema = z
  .string()
  .min(1)
  .regex(
    CAPABILITY_SLUG_PATTERN,
    "must be an Oxagen capability or core-tool slug",
  );

/**
 * A sidecar file path relative to the artifact that names it. Rejects absolute
 * paths, `..` traversal, and empty segments. This is a *lexical* check only —
 * `resolveContainedPath` in `paths.ts` is what resolves symlinks and proves
 * the file really lands inside the bundle.
 */
const containedRelativePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/") && !value.startsWith("\\"), {
    message: "must be relative",
  })
  .refine(
    (value) =>
      !value
        .replaceAll("\\", "/")
        .split("/")
        .some((segment) => segment === ".." || segment === ""),
    { message: "must stay within the artifact bundle" },
  );

const schemaReferenceSchema = z
  .object({ schema: containedRelativePathSchema })
  .strict();

/**
 * An agent: instructions, the tools it may call, and an optional lifecycle
 * driver. `unresolved_tools` holds tool names an import could not map onto an
 * Oxagen capability; a non-empty list is what marks the artifact
 * `needs_review`, so it is preserved rather than dropped.
 */
export const agentArtifactSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal("agent"),
    name: artifactNameSchema,
    description: z.string().min(1),
    model: z.string().min(1).optional(),
    developer_instructions: z.string().min(1),
    tools: z.array(capabilitySlugSchema).default([]),
    skills: z.array(artifactNameSchema).default([]),
    unresolved_tools: z.array(z.string().min(1)).default([]),
    input: schemaReferenceSchema.optional(),
    output: schemaReferenceSchema.optional(),
    driver: agentDriverSchema.optional(),
  })
  .strict();

/** A skill: reusable instructions plus contained reference files to inline. */
export const skillArtifactSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal("skill"),
    name: artifactNameSchema,
    description: z.string().min(1),
    instructions: z.string().min(1),
    references: z.array(containedRelativePathSchema).default([]),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/** A slash command: a prompt template, optionally bound to a named agent. */
export const commandArtifactSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal("command"),
    name: artifactNameSchema,
    description: z.string().min(1),
    argument_hint: z.string().optional(),
    prompt: z.string().min(1),
    agent: artifactNameSchema.optional(),
    model: z.string().min(1).optional(),
  })
  .strict();

/**
 * Every artifact this package understands, discriminated on `kind`. This is the
 * single validation gate for artifact TOML — `codec.ts` parses through it and
 * `hash.ts` re-validates before hashing, so nothing unvalidated ever gets a
 * content hash.
 */
export const artifactSchema = z.discriminatedUnion("kind", [
  agentArtifactSchema,
  skillArtifactSchema,
  commandArtifactSchema,
]);
