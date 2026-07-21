import { z } from "zod";
import { agentDriverSchema } from "./lifecycle";

const artifactNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a kebab-case artifact slug");

export const capabilitySlugSchema = z
  .string()
  .min(1)
  .regex(
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/,
    "must be an Oxagen capability or core-tool slug",
  );

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

export const artifactSchema = z.discriminatedUnion("kind", [
  agentArtifactSchema,
  skillArtifactSchema,
  commandArtifactSchema,
]);
