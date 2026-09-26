// server.ts: `mcp-server/v1`, the schema of tools/servers/<name>/server.toml
// (mcp-studio-spec, Server file).
//
// server.toml says where a server's tools come from, how to reach it in each
// environment, which credential the gateway uses, and how its tools are
// exposed. A credential is a reference into Oxagen's vault. No secret value
// ever sits in the file.
import { z } from "zod";
import { credentialRefSchema, repoPathSchema } from "@oxagen/oxagen/steering-repo/common";
import { DEFAULT_SERVER_DEFINITION_BUDGET } from "@oxagen/oxagen/steering-repo/tokens";
import { uniqueList, withChecks, type CustomCheck } from "./checks";
import {
  environmentNameSchema,
  headerNameSchema,
  httpUrlSchema,
  networkSchema,
  serverNameSchema,
} from "./primitives";

/** A repository as the steering repo names one: `github.com/a-intel/billing-service`. */
export const sourceRepoSchema = z
  .string()
  .regex(
    /^(?:github\.com|gitlab\.com)\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/,
    "a repository is github.com/<owner>/<name> or gitlab.com/<group>/<name>",
  );

/** A git branch, tag, or commit. */
export const gitRefSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\s~^:?*[\\]+$/, "not a git ref");

const networkField = networkSchema
  .optional()
  .describe("cloud by default, or relay:<name> for a server inside a private network.");

// ── Sources ──────────────────────────────────────────────────────────────────

export const remoteSourceSchema = z
  .object({
    type: z.literal("remote"),
    url: httpUrlSchema.describe("The MCP endpoint."),
    transport: z
      .enum(["http", "sse"])
      .describe("http (streamable HTTP) or sse, which today's connect flow still offers."),
    network: networkField,
  })
  .strict()
  .describe("A remote MCP server.");

export const registrySourceSchema = z
  .object({
    type: z.literal("registry"),
    registry: httpUrlSchema.describe("The registry's URL."),
    server: z
      .string()
      .min(3)
      .max(200)
      .regex(
        /^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/,
        "a registry name is <namespace>/<name>, such as io.github.github/github-mcp-server",
      )
      .describe("The server's registry name."),
    version: z.string().min(1).max(64).describe("The catalog version. The entry supplies the endpoint or the package."),
    network: networkField,
  })
  .strict()
  .describe("An MCP server from a registry catalog.");

/** An environment variable's name. Its value stays on the machine. */
const envVarNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, "not an environment variable name");

/** A machine group an admin made in Oxagen. */
const machineGroupSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "a machine group is lowercase letters, digits, and hyphens");

export const localSourceSchema = z
  .object({
    type: z.literal("local"),
    command: z.string().min(1).max(1024).describe("The command the local gateway runs."),
    args: z.array(z.string().max(4096)).max(256).optional(),
    env: uniqueList(envVarNameSchema, "source.env", 128)
      .optional()
      .describe("Environment variables the local gateway passes from the machine. Only names, never values."),
    machines: uniqueList(machineGroupSchema, "source.machines", 64)
      .optional()
      .describe("The machine groups that may run the server. Empty by default, so it runs nowhere."),
  })
  .strict()
  .describe("A local MCP server the local gateway runs on an enrolled machine.");

const definitionLocationChecks = (extra: readonly string[]) => [
  {
    kind: "require" as const,
    when: { field: "from", is: "repository" },
    fields: ["repo", "path", "ref"],
  },
  { kind: "forbid" as const, when: { field: "from", is: "repository" }, fields: ["url"] },
  { kind: "require" as const, when: { field: "from", is: "url" }, fields: ["url"] },
  {
    kind: "forbid" as const,
    when: { field: "from", is: "url" },
    fields: ["repo", "path", "ref"],
  },
  ...["upload", ...extra].map((from) => ({
    kind: "forbid" as const,
    when: { field: "from", is: from },
    fields: ["repo", "path", "ref", "url"],
  })),
];

function definitionSource<Type extends "openapi" | "graphql" | "grpc">(
  type: Type,
  froms: readonly [string, ...string[]],
  describe: string,
) {
  return withChecks(
    z
      .object({
        type: z.literal(type),
        from: z.enum(froms as [string, ...string[]]),
        repo: sourceRepoSchema.optional(),
        path: repoPathSchema.optional().describe("The definition's path in repo."),
        ref: gitRefSchema.optional().describe("The branch, tag, or commit to read."),
        url: httpUrlSchema.optional().describe("Where Oxagen fetches the definition."),
        network: networkField,
      })
      .strict()
      .describe(describe),
    definitionLocationChecks(froms.slice(3)),
  );
}

export const openapiSourceSchema = definitionSource(
  "openapi",
  ["repository", "url", "upload"],
  "An OpenAPI 3.0 or 3.1 document, or Swagger 2.0.",
);
export const graphqlSourceSchema = definitionSource(
  "graphql",
  ["repository", "url", "upload", "introspection"],
  "A GraphQL schema. introspection reads it from the first environment's endpoint.",
);
export const grpcSourceSchema = definitionSource(
  "grpc",
  ["repository", "url", "upload", "reflection"],
  "A protobuf package. reflection reads it from the first environment's endpoint.",
);

export const serverSourceSchema = z.union([
  remoteSourceSchema,
  registrySourceSchema,
  localSourceSchema,
  openapiSourceSchema,
  graphqlSourceSchema,
  grpcSourceSchema,
]);
export type ServerSource = z.output<typeof serverSourceSchema>;
export type ServerSourceType = ServerSource["type"];

/** The source types built from a definition, whose tools come from import. */
export const DEFINITION_SOURCE_TYPES = ["openapi", "graphql", "grpc"] as const;
export type DefinitionSourceType = (typeof DEFINITION_SOURCE_TYPES)[number];

export function isDefinitionSource(
  source: ServerSource,
): source is Extract<ServerSource, { type: DefinitionSourceType }> {
  return (DEFINITION_SOURCE_TYPES as readonly string[]).includes(source.type);
}

// ── Auth and environments ────────────────────────────────────────────────────

/** The schemes every source but OpenAPI takes. OpenAPI names a key of components.securitySchemes. */
export const AUTH_SCHEMES = ["oauth", "bearer", "basic", "header"] as const;

export const serverAuthSchema = withChecks(
  z
    .object({
      mode: z
        .enum(["none", "service", "operator-oauth"])
        .describe("none, service (one credential for every run), or operator-oauth (the operator's own token)."),
      scheme: z
        .string()
        .regex(/^[A-Za-z0-9_.-]{1,64}$/, "not a scheme name")
        .optional()
        .describe(
          "For OpenAPI, a key of components.securitySchemes. For every other source, oauth, bearer, basic, or header.",
        ),
      header: headerNameSchema.optional().describe("The header that carries the credential when scheme is header."),
      credential: credentialRefSchema
        .optional()
        .describe("oxagen:credential/<name>. Required unless the mode is none or every environment names one."),
    })
    .strict(),
  [
    { kind: "forbid", when: { field: "mode", is: "none" }, fields: ["scheme", "header", "credential"] },
    { kind: "require", when: { field: "mode", isNot: "none" }, fields: ["scheme"] },
  ],
);
export type ServerAuth = z.output<typeof serverAuthSchema>;

export const serverEnvironmentSchema = z
  .object({
    sandbox: z
      .boolean()
      .optional()
      .describe(
        "Marks the environment every agent's calls go to. Exactly one environment is the sandbox when a server has two or more.",
      ),
    url: httpUrlSchema.optional().describe("The endpoint in this environment."),
    network: networkSchema.optional(),
    credential: credentialRefSchema.optional(),
  })
  .strict();
export type ServerEnvironment = z.output<typeof serverEnvironmentSchema>;

export const exposureSchema = z
  .object({
    mode: z
      .enum(["direct", "search"])
      .describe("direct lists every tool. search exposes <server>__search, <server>__describe, and <server>__call."),
    definition_budget: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(`Tokens for every tool definition together. ${DEFAULT_SERVER_DEFINITION_BUDGET} when omitted.`),
  })
  .strict();
export type Exposure = z.output<typeof exposureSchema>;

export const syncSchema = z
  .object({
    schedule: z
      .enum(["on-change", "daily", "manual"])
      .describe("on-change (a definition in a linked repository), daily, or manual."),
  })
  .strict();

// ── Server-level checks ──────────────────────────────────────────────────────

type Loose = Record<string, unknown>;

function sourceType(value: Loose): string | undefined {
  const source = value.source as Loose | undefined;
  return typeof source?.type === "string" ? source.type : undefined;
}

function environments(value: Loose): [string, Loose][] {
  const table = value.environments as Record<string, Loose> | undefined;
  return table === undefined ? [] : Object.entries(table);
}

const sourceIs = (types: readonly string[]) => ({
  properties: { source: { properties: { type: { enum: [...types] } } } },
});

/** A local server takes no auth and no environments. Every other server names its auth. */
const localHasNoAuth: CustomCheck = {
  issues(value) {
    if (sourceType(value) !== "local") {
      return value.auth === undefined
        ? [{ path: ["auth"], message: "auth is required unless the source is local. Write mode = \"none\" for none." }]
        : [];
    }
    return (["auth", "environments"] as const)
      .filter((field) => value[field] !== undefined)
      .map((field) => ({
        path: [field],
        message: `${field} is not allowed for a local server, which gets no credential from Oxagen`,
      }));
  },
  json: {
    if: sourceIs(["local"]),
    then: { not: { anyOf: [{ required: ["auth"] }, { required: ["environments"] }] } },
    else: { required: ["auth"] },
  },
};

/** A server built from a definition needs at least one environment, and each one names its url. */
const definitionNeedsEnvironments: CustomCheck = {
  issues(value) {
    if (!(DEFINITION_SOURCE_TYPES as readonly string[]).includes(sourceType(value) ?? "")) return [];
    const envs = environments(value);
    if (envs.length === 0) {
      return [
        {
          path: ["environments"],
          message: "a server built from a definition needs at least one environment with its url",
        },
      ];
    }
    return envs
      .filter(([, env]) => env.url === undefined)
      .map(([name]) => ({
        path: ["environments", name, "url"],
        message: "url is required: a server built from a definition takes its endpoint from the environment",
      }));
  },
  json: {
    if: sourceIs(DEFINITION_SOURCE_TYPES),
    then: {
      required: ["environments"],
      properties: {
        environments: { minProperties: 1, additionalProperties: { required: ["url"] } },
      },
    },
  },
};

/** The scheme names and the header rule for every source but OpenAPI. */
const schemeFitsSource: CustomCheck = {
  issues(value) {
    const auth = value.auth as Loose | undefined;
    if (auth === undefined) return [];
    if (sourceType(value) === "openapi") {
      return auth.header === undefined
        ? []
        : [
            {
              path: ["auth", "header"],
              message: "auth.header is not allowed for OpenAPI, whose security scheme names the header",
            },
          ];
    }
    const issues: { path: string[]; message: string }[] = [];
    if (auth.scheme !== undefined && !(AUTH_SCHEMES as readonly unknown[]).includes(auth.scheme)) {
      issues.push({ path: ["auth", "scheme"], message: `auth.scheme is one of ${AUTH_SCHEMES.join(", ")}` });
    }
    if (auth.scheme === "header" && auth.header === undefined) {
      issues.push({ path: ["auth", "header"], message: "auth.header is required when scheme is header" });
    }
    if (auth.scheme !== "header" && auth.header !== undefined) {
      issues.push({ path: ["auth", "header"], message: "auth.header is allowed only when scheme is header" });
    }
    return issues;
  },
  json: {
    if: sourceIs(["openapi"]),
    then: { properties: { auth: { not: { required: ["header"] } } } },
    else: {
      properties: {
        auth: {
          properties: { scheme: { enum: [...AUTH_SCHEMES] } },
          if: { properties: { scheme: { const: "header" } }, required: ["scheme"] },
          then: { required: ["header"] },
          else: { not: { required: ["header"] } },
        },
      },
    },
  },
};

/** A credential is named once for the server, or in every environment, unless the mode is none. */
const credentialNamed: CustomCheck = {
  issues(value) {
    const auth = value.auth as Loose | undefined;
    if (auth === undefined || auth.mode === "none" || auth.credential !== undefined) return [];
    const envs = environments(value);
    if (envs.length > 0 && envs.every(([, env]) => env.credential !== undefined)) return [];
    return [
      {
        path: ["auth", "credential"],
        message: "auth.credential is required unless the mode is none or every environment names a credential",
      },
    ];
  },
  json: {
    if: {
      required: ["auth"],
      properties: { auth: { required: ["mode"], properties: { mode: { not: { const: "none" } } } } },
    },
    then: {
      anyOf: [
        { properties: { auth: { required: ["credential"] } } },
        {
          required: ["environments"],
          properties: {
            environments: { minProperties: 1, additionalProperties: { required: ["credential"] } },
          },
        },
      ],
    },
  },
};

/**
 * Every agent's calls go to the sandbox (Mac, 2026-09-26). A server with two
 * or more environments marks exactly one `sandbox = true`. A server with one
 * environment, or none (which means one, default), uses it and needs no
 * mark. No agent setting picks another environment. JSON Schema cannot count
 * across a table's keys, so the published schema requires at least one
 * sandbox and only zod refuses a second.
 */
const oneSandbox: CustomCheck = {
  issues(value) {
    const envs = environments(value);
    const sandboxes = envs.filter(([, env]) => env.sandbox === true);
    if (envs.length >= 2 && sandboxes.length === 0) {
      return [
        {
          path: ["environments"],
          message:
            "mark one environment sandbox = true: every agent's calls go to the sandbox when a server has two or more environments",
        },
      ];
    }
    return sandboxes.slice(1).map(([name]) => ({
      path: ["environments", name, "sandbox"],
      message: `only one environment may be the sandbox, and ${sandboxes[0]?.[0] ?? ""} already is`,
    }));
  },
  json: {
    if: { required: ["environments"], properties: { environments: { minProperties: 2 } } },
    then: {
      properties: {
        environments: {
          not: {
            additionalProperties: {
              not: { required: ["sandbox"], properties: { sandbox: { const: true } } },
            },
          },
        },
      },
    },
  },
};

export const mcpServerSchema = withChecks(
  z
    .object({
      schema: z.literal("mcp-server/v1"),
      name: serverNameSchema.describe("Matches the folder name. Unique in the workspace."),
      label: z.string().min(1).max(80).describe("The server's name on every surface."),
      description: z.string().min(1).max(200).describe("One sentence about the server."),
      source: serverSourceSchema,
      auth: serverAuthSchema.optional().describe("Required unless the source is local."),
      environments: z
        .record(environmentNameSchema, serverEnvironmentSchema)
        .optional()
        .describe("Overrides of url, network, and credential. A server with none has one environment, default."),
      exposure: exposureSchema,
      sync: syncSchema,
    })
    .strict(),
  [localHasNoAuth, definitionNeedsEnvironments, schemeFitsSource, credentialNamed, oneSandbox],
);
export type McpServer = z.output<typeof mcpServerSchema>;

/** The environment a server has when server.toml names none. */
export const DEFAULT_ENVIRONMENT = "default";

/**
 * The environment every agent's calls go to: the one marked sandbox, or the
 * only one. A server with no [environments] table has one, default. Try it in
 * Studio lets an operator pick any environment. No agent setting does.
 */
export function agentEnvironment(server: Pick<McpServer, "environments">): string {
  const envs = Object.entries(server.environments ?? {});
  if (envs.length === 0) return DEFAULT_ENVIRONMENT;
  const [only] = envs;
  if (envs.length === 1 && only !== undefined) return only[0];
  const sandbox = envs.find(([, env]) => env.sandbox === true);
  if (sandbox === undefined) throw new TypeError("a server with two or more environments marks one sandbox = true");
  return sandbox[0];
}
