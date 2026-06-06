import { z } from "zod";

/** A sized icon for UI rendering. */
export const iconSchema = z.object({
  src: z.string().url(),
  mimeType: z.string().optional(),
  sizes: z.array(z.string()).optional(),
  theme: z.enum(["light", "dark"]).optional(),
});

/** Source repository metadata. */
export const repositorySchema = z.object({
  url: z.string(),
  source: z.string(),
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
      .array(z.object({ name: z.string() }).merge(secretFlagSchema).passthrough())
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
    variables: z.record(z.object({}).merge(secretFlagSchema).passthrough()).optional(),
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
    icons: z.array(iconSchema).optional(),
    packages: z.array(packageSchema).optional(),
    remotes: z.array(remoteSchema).optional(),
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
