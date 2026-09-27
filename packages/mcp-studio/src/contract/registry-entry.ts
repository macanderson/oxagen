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

export const registryPackageSchema = z
  .object({
    registryType: z.string().min(1).describe("npm, pypi, oci, nuget, or mcpb."),
    identifier: z.string().min(1),
    version: z.string().min(1).optional(),
    transport: z.object({ type: z.string().min(1) }).passthrough(),
  })
  .passthrough();

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
