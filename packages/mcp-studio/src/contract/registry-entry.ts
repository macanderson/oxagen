// registry-entry.ts: one server entry of an MCP registry catalog, the part a
// `registry` source reads (mcp-studio-spec, Sources).
//
// The registry owns this format, so the schema checks only the fields
// Oxagen reads and passes every other key through.
import { z } from "zod";
import { httpUrlSchema } from "./primitives";

export const registryRemoteSchema = z
  .object({
    type: z.string().min(1).describe("streamable-http or sse."),
    url: httpUrlSchema,
  })
  .passthrough();

/** The input fields of an argument that registryLaunch reads. */
const registryInputShape = {
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional().describe("A secret takes its value from ${NAME} only."),
  value: z.string().optional().describe("A fixed value. The registry says a person does not change it."),
  default: z.string().optional().describe("The value when source.arguments sets none."),
  variables: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Inputs the registry fills into {name} in value or default. The local gateway fills none."),
};

/** A positional argument. source.arguments sets it by its valueHint. */
export const registryPositionalArgumentSchema = z
  .object({
    type: z.literal("positional"),
    valueHint: z.string().min(1).optional(),
    ...registryInputShape,
  })
  .passthrough();

/** A named argument: its name, then its value. source.arguments sets it by its name. */
export const registryNamedArgumentSchema = z
  .object({
    type: z.literal("named"),
    name: z.string().min(1).describe("The flag, such as --port."),
    ...registryInputShape,
  })
  .passthrough();

export const registryArgumentSchema = z.union([registryPositionalArgumentSchema, registryNamedArgumentSchema]);
export type RegistryArgument = z.output<typeof registryArgumentSchema>;

/** An environment variable the package reads. source.env lists every required one. */
export const registryEnvironmentVariableSchema = z
  .object({
    name: z.string().min(1),
    isRequired: z.boolean().optional(),
  })
  .passthrough();

export const registryPackageSchema = z
  .object({
    registryType: z.string().min(1).describe("npm, pypi, oci, nuget, or mcpb."),
    identifier: z.string().min(1),
    version: z.string().min(1).optional(),
    transport: z.object({ type: z.string().min(1) }).passthrough(),
    runtimeHint: z.string().min(1).optional().describe("The runner the entry expects, such as npx or docker."),
    runtimeArguments: z
      .array(registryArgumentSchema)
      .optional()
      .describe("Arguments to the runner, before the package reference."),
    packageArguments: z
      .array(registryArgumentSchema)
      .optional()
      .describe("Arguments to the package, after its reference."),
    environmentVariables: z.array(registryEnvironmentVariableSchema).optional(),
  })
  .passthrough();
export type RegistryPackage = z.output<typeof registryPackageSchema>;

export const registryEntrySchema = z
  .object({
    server: z
      .object({
        name: z.string().regex(/^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/, "a registry name is <namespace>/<name>"),
        description: z.string().min(1),
        version: z.string().min(1),
        remotes: z.array(registryRemoteSchema).optional(),
        packages: z.array(registryPackageSchema).optional(),
      })
      .passthrough(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type RegistryEntry = z.output<typeof registryEntrySchema>;
