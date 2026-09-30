// lock.ts: `mcp-tools-lock/v1`, the schema of tools/servers/<name>/tools.lock.json
// (mcp-studio-spec, Lock file).
//
// The lock pins the upstream definition of every imported tool as a person
// reviewed it. The gateway serves only locked definitions, so what the model
// reads changes only through a steering PR. Oxagen writes it, and nobody
// edits it by hand.
//
// An MCP server's lock pins the tools/list entry. A server built from a
// definition pins the UpstreamTool compiled from it before tools.toml
// applies, so a changed document shows as a change per tool.
import { z } from "zod";
import { gitObjectIdSchema, repoPathSchema, sha256Schema } from "@oxagen/oxagen/steering-repo/common";
import { securitySchemeSchema } from "../model/security-scheme";
import { upstreamToolSchema } from "../model/upstream-tool";
import { allowedOnlyWith, dependentRequired, withChecks, type CustomCheck } from "./checks";
import { lockedMcpToolSchema } from "./mcp-tool";
import { httpUrlSchema, remoteTransportSchema, serverNameSchema, toolKeySchema } from "./primitives";
import {
  DEFINITION_FROMS,
  definitionLocationChecks,
  gitRefSchema,
  registryTypeSchema,
  sourceRepoSchema,
} from "./server";

/** A lock file is at most 5 MB. */
export const LOCK_BYTES_MAX = 5 * 1024 * 1024;

const serverVersionSchema = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe("The version the server reported in initialize, when it reported one.");

/** A local server's package, pinned. The local gateway refuses to start anything else. */
export const lockPackageSchema = z
  .object({
    name: z.string().min(1).max(214).describe("The package or binary: @modelcontextprotocol/server-filesystem."),
    version: z.string().min(1).max(64),
    digest: sha256Schema.describe("SHA-256 of the package or binary."),
  })
  .strict();
export type LockPackage = z.output<typeof lockPackageSchema>;

/**
 * The one file of a PyPI release a pin names (ADR-233): the release's
 * universal wheel, or its source distribution. The launch installs it by its
 * URL, and the digest is that file's.
 */
export const pypiLockFileSchema = z
  .object({
    name: z.string().min(1).max(255).describe("The file's name on the index: mcp_server_git-1.2.0-py3-none-any.whl."),
    url: z
      .string()
      .url()
      .regex(
        /^https:\/\/[^/?#@]*(?:[/?#]|$)/,
        "a PyPI file's URL starts with https:// and has no user name or password",
      )
      .describe("The URL the launch installs the file from, after uvx --from."),
  })
  .strict();
export type PypiLockFile = z.output<typeof pypiLockFileSchema>;

/** A PyPI package pins one file, and no other type names one. */
const fileOnlyForPypi: CustomCheck = {
  issues(value) {
    if (value.registry_type === "pypi" && value.file === undefined) {
      return [{ path: ["file"], message: "file is required for a pypi package: the pin names one file of the release" }];
    }
    if (value.registry_type !== "pypi" && value.file !== undefined) {
      return [{ path: ["file"], message: "file is allowed only for a pypi package" }];
    }
    return [];
  },
  json: {
    if: { properties: { registry_type: { const: "pypi" } }, required: ["registry_type"] },
    then: { required: ["file"] },
    else: { not: { required: ["file"] } },
  },
};

/**
 * A registry entry's package, pinned: which of the entry's packages the
 * source picked, and the digest the local gateway checks before it starts it.
 */
export const registryLockPackageSchema = withChecks(
  lockPackageSchema.extend({
    registry_type: registryTypeSchema.describe("source.registry_type: npm, pypi, oci, or nuget."),
    digest: sha256Schema.describe(
      "For oci, the image's manifest digest. For pypi, the SHA-256 of file. For the others, the SHA-256 of the package archive.",
    ),
    file: pypiLockFileSchema.optional().describe("For pypi: the one file of the release the launch installs."),
  }),
  [fileOnlyForPypi],
);
export type RegistryLockPackage = z.output<typeof registryLockPackageSchema>;

export const remoteLockSourceSchema = z
  .object({
    type: z.literal("remote"),
    url: httpUrlSchema,
    server_version: serverVersionSchema,
  })
  .strict();

/**
 * A catalog entry names either an endpoint or a package, so its lock source
 * records exactly one of url and package.
 */
const urlOrPackage: CustomCheck = {
  issues(value) {
    if (value.url !== undefined && value.package !== undefined) {
      return [
        {
          path: ["package"],
          message: "package is not allowed when url is set: a catalog entry names an endpoint or a package",
        },
      ];
    }
    if (value.url === undefined && value.package === undefined) {
      return [{ path: ["url"], message: "url or package is required: the catalog entry names one of them" }];
    }
    return [];
  },
  json: { oneOf: [{ required: ["url"] }, { required: ["package"] }] },
};

/** Only a remote entry is reached by a transport, so a lock source with no url names none. */
const transportOnlyWithUrl = allowedOnlyWith("url", ["transport"], "only a remote entry has one");

/** Only a package has a launch, so a lock source with a url names no command or args. */
const launchOnlyWithPackage = allowedOnlyWith("package", ["command", "args"], "only a package entry has a launch");

/**
 * A registry server's source as the lock pins it. server.toml names only the
 * catalog entry, so the lock records what the entry resolved to. For a remote
 * entry that is the endpoint and how to reach it, so the gateway connects the
 * same way on every call. The catalog's streamable-http is http here, as in
 * server.toml's remote source. For a package that is the package and the
 * command and args the local gateway runs, which registryLaunch builds.
 */
export const registryLockSourceSchema = withChecks(
  z
    .object({
      type: z.literal("registry"),
      registry: httpUrlSchema,
      server: z.string().min(3).max(200),
      version: z.string().min(1).max(64),
      url: httpUrlSchema.optional().describe("The endpoint the catalog entry named, for a remote entry."),
      transport: remoteTransportSchema
        .optional()
        .describe(
          "How the catalog entry reaches url: http, the catalog's streamable-http. The lock pins no sse remote (ADR-211).",
        ),
      package: registryLockPackageSchema
        .optional()
        .describe("The package the local gateway runs, when server.toml names machines."),
      command: z
        .string()
        .min(1)
        .max(1024)
        .optional()
        .describe("For a package: the command the local gateway runs, npx, uvx, docker, or dnx."),
      args: z
        .array(z.string().max(4096))
        .max(1024)
        .optional()
        .describe(
          "For a package: the command's arguments. ${NAME} stays for the local gateway to fill from the machine, and $$ writes one $.",
        ),
      server_version: serverVersionSchema,
    })
    .strict(),
  [
    urlOrPackage,
    dependentRequired("url", ["transport"]),
    transportOnlyWithUrl,
    dependentRequired("package", ["command", "args"]),
    launchOnlyWithPackage,
  ],
);

export const localLockSourceSchema = z
  .object({
    type: z.literal("local"),
    command: z.string().min(1).max(1024),
    package: lockPackageSchema,
    server_version: serverVersionSchema,
  })
  .strict();

/** Where an MCP server's tools came from when the lock was written. */
export const mcpLockSourceSchema = z.union([
  remoteLockSourceSchema,
  registryLockSourceSchema,
  localLockSourceSchema,
]);
export type McpLockSource = z.output<typeof mcpLockSourceSchema>;

type DefinitionType = keyof typeof DEFINITION_FROMS;

const DEFINITION_LABELS: Record<DefinitionType, string> = {
  openapi: "an OpenAPI",
  graphql: "a GraphQL",
  grpc: "a gRPC",
};

/**
 * A lock source's from is one its type can come from, as in server.toml.
 * OpenAPI has no introspection or reflection, and GraphQL and gRPC each
 * have only their own.
 */
const fromFitsType: CustomCheck = {
  issues(value) {
    const type = value.type as DefinitionType;
    const froms: readonly string[] = DEFINITION_FROMS[type];
    return froms.includes(String(value.from))
      ? []
      : [
          {
            path: ["from"],
            message: `${DEFINITION_LABELS[type]} definition comes from one of ${froms.join(", ")}`,
          },
        ];
  },
  json: {
    allOf: Object.entries(DEFINITION_FROMS).map(([type, froms]) => ({
      if: { properties: { type: { const: type } }, required: ["type"] },
      then: { properties: { from: { enum: [...froms] } } },
    })),
  },
};

/**
 * Where a definition came from when the lock was written, and the hash of
 * its bytes. It follows server.toml's source rules, and a repository source
 * also records the commit its ref resolved to.
 */
export const definitionLockSourceSchema = withChecks(
  z
    .object({
      type: z.enum(["openapi", "graphql", "grpc"]),
      from: z.enum(["repository", "url", "upload", "introspection", "reflection"]),
      document_hash: sha256Schema.describe(
        "SHA-256 of the definition's bytes as committed, or of the bundle for many files.",
      ),
      repo: sourceRepoSchema.optional(),
      path: repoPathSchema.optional(),
      ref: gitRefSchema.optional(),
      commit: gitObjectIdSchema.optional().describe("The commit ref resolved to when the lock was written."),
      url: httpUrlSchema.optional(),
      security_schemes: z
        .record(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, "not a scheme name"), securitySchemeSchema)
        .optional()
        .describe(
          "OpenAPI only: components.securitySchemes as import read them, so compile resolves auth.scheme without the document.",
        ),
    })
    .strict(),
  [
    fromFitsType,
    ...definitionLocationChecks(["introspection", "reflection"], ["repo", "path", "ref", "commit"]),
    { kind: "forbid", when: { field: "type", is: "graphql" }, fields: ["security_schemes"] },
    { kind: "forbid", when: { field: "type", is: "grpc" }, fields: ["security_schemes"] },
  ],
);
export type DefinitionLockSource = z.output<typeof definitionLockSourceSchema>;

const versionSchema = z
  .number()
  .int()
  .min(1)
  .describe("Rises by one when definition_hash changes. Never for a classification change.");

const definitionHashSchema = sha256Schema.describe(
  "SHA-256 over the RFC 8785 form of the effective name, description, and schemas.",
);
const upstreamHashSchema = sha256Schema.describe("SHA-256 over the RFC 8785 form of upstream.");

export const mcpLockedToolSchema = z
  .object({
    definition_hash: definitionHashSchema,
    upstream: lockedMcpToolSchema,
    upstream_hash: upstreamHashSchema,
    version: versionSchema,
  })
  .strict();

export const definitionLockedToolSchema = z
  .object({
    definition_hash: definitionHashSchema,
    upstream: upstreamToolSchema,
    upstream_hash: upstreamHashSchema,
    version: versionSchema,
  })
  .strict();

export const mcpLockSchema = z
  .object({
    schema: z.literal("mcp-tools-lock/v1"),
    server: serverNameSchema,
    source: mcpLockSourceSchema,
    tools: z.record(toolKeySchema, mcpLockedToolSchema),
  })
  .strict()
  .describe("The lock of an MCP server: remote, registry, or local.");

export const definitionLockSchema = z
  .object({
    schema: z.literal("mcp-tools-lock/v1"),
    server: serverNameSchema,
    source: definitionLockSourceSchema,
    tools: z.record(toolKeySchema, definitionLockedToolSchema),
  })
  .strict()
  .describe("The lock of a server built from an OpenAPI, GraphQL, or gRPC definition.");

export const mcpToolsLockSchema = z.union([mcpLockSchema, definitionLockSchema]);
export type McpToolsLock = z.output<typeof mcpToolsLockSchema>;
export type McpLock = z.output<typeof mcpLockSchema>;
export type DefinitionLock = z.output<typeof definitionLockSchema>;
export type LockedTool = McpToolsLock["tools"][string];
