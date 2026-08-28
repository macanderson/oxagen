import { z } from "zod";

/** A sized icon for UI rendering. */
export const iconSchema = z.object({
  // Relaxed from z.string().url() so that Lucide icon names (non-URL strings)
  // do not nuke the entire registry fetch. The SHARED ICON DATA CONTRACT defines
  // the runtime branch: http(s)/data URI → <Image>; plain string → Lucide icon.
  src: z.string().min(1),
  // Hex accent color forwarded from static capability-pack manifests.
  color: z.string().optional(),
  mimeType: z.string().optional(),
  sizes: z.array(z.string()).optional(),
  theme: z.enum(["light", "dark"]).optional(),
});

/** Source repository metadata. */
export const repositorySchema = z.object({
  // .nullish() (accepts `undefined` AND `null`), NOT z.string(): the live MCP
  // Registry (registry.modelcontextprotocol.io) returns server records whose
  // `repository` object is present but omits `url`/`source`. If these were
  // required, one such server would fail validation and drop the entire
  // /v0.1/servers page (listServers throws → catalog browse/sync returns 0
  // results). Same reasoning applies to icons/packages/remotes below.
  // Downstream reads are null-safe (catalog-sync: `repository?.url ?? null`).
  url: z.string().nullish(),
  source: z.string().nullish(),
  id: z.string().optional(),
  subfolder: z.string().optional(),
});

/** A declared secret-bearing input (env var / header / remote variable). */
export const secretFlagSchema = z.object({
  isSecret: z.boolean().optional(),
  isRequired: z.boolean().optional(),
});

/** Local package install descriptor. */
export const packageSchema = z
  .object({
    registryType: z.string(),
    identifier: z.string(),
    version: z.string().optional(),
    transport: z.object({ type: z.string() }).passthrough().optional(),
    runtimeHint: z.string().optional(),
    environmentVariables: z
      .array(
        z.object({ name: z.string() }).merge(secretFlagSchema).passthrough(),
      )
      .optional(),
  })
  .passthrough();

/** Remote (hosted) transport descriptor. */
export const remoteSchema = z
  .object({
    type: z.string(),
    url: z.string(),
    headers: z
      .array(
        z
          .object({ name: z.string(), value: z.string().optional() })
          .merge(secretFlagSchema)
          .passthrough(),
      )
      .optional(),
    variables: z
      .record(z.object({}).merge(secretFlagSchema).passthrough())
      .optional(),
  })
  .passthrough();

/** The publisher-authored server record. */
export const serverDetailSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    version: z.string(),
    title: z.string().optional(),
    repository: repositorySchema.optional(),
    websiteUrl: z.string().optional(),
    // .nullish() accepts both `undefined` and `null`. The live MCP Registry
    // (registry.modelcontextprotocol.io) returns `null` for these fields on
    // servers that haven't declared them; `.optional()` only handles `undefined`
    // and would throw a ZodError, silently dropping the entire registry fetch.
    icons: z.array(iconSchema).nullish(),
    packages: z.array(packageSchema).nullish(),
    remotes: z.array(remoteSchema).nullish(),
  })
  .passthrough();

/** Registry-managed metadata wrapper. */
export const serverMetaSchema = z
  .object({
    status: z.enum(["active", "deprecated", "deleted"]).optional(),
    statusMessage: z.string().optional(),
    statusChangedAt: z.string().optional(),
    publishedAt: z.string().optional(),
    updatedAt: z.string().optional(),
    isLatest: z.boolean().optional(),
  })
  .passthrough();

export const serverResponseSchema = z.object({
  server: serverDetailSchema,
  _meta: serverMetaSchema.optional(),
});

export const listServersResponseSchema = z.object({
  servers: z.array(serverResponseSchema),
  metadata: z
    .object({ nextCursor: z.string().optional(), count: z.number().optional() })
    .optional(),
});

export type Icon = z.infer<typeof iconSchema>;
export type Repository = z.infer<typeof repositorySchema>;
export type ServerDetail = z.infer<typeof serverDetailSchema>;
export type ServerMeta = z.infer<typeof serverMetaSchema>;
export type ServerResponse = z.infer<typeof serverResponseSchema>;
export type ListServersResponse = z.infer<typeof listServersResponseSchema>;
