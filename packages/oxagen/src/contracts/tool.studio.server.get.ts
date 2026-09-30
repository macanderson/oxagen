import { z } from "zod";
import { registerCapability } from "../registry";
import { studioServerNameSchema } from "./tool.studio.draft.save";
import { studioToolsListOutputSchema } from "./tool.studio.tools.list";

const isoDateSchema = z.string().datetime();

/**
 * server.toml's `[source]`, one shape per source type, with the TOML keys in
 * camelCase. A registry source's `arguments` are left out: a value there may
 * be a literal, and no Studio screen shows it.
 */
const studioSourceSchema = z.union([
  z.object({
    type: z.literal("remote"),
    url: z.string(),
    transport: z.string(),
    network: z.string().nullable(),
  }),
  z.object({
    type: z.literal("registry"),
    /** The registry's URL. */
    registry: z.string(),
    /** The entry's registry name, such as `io.github.github/github-mcp-server`. */
    server: z.string(),
    version: z.string(),
    network: z.string().nullable(),
    /** The machine groups whose local gateway runs the package; empty for the remote. */
    machines: z.array(z.string()),
    /** The package type the local gateway runs, or null for the remote. */
    registryType: z.enum(["npm", "pypi", "oci", "nuget"]).nullable(),
    /** Names of the environment variables passed through, never their values. */
    env: z.array(z.string()),
  }),
  z.object({
    type: z.literal("local"),
    command: z.string(),
    args: z.array(z.string()),
    /** Names of the environment variables passed through, never their values. */
    env: z.array(z.string()),
    machines: z.array(z.string()),
  }),
  z.object({
    type: z.enum(["openapi", "graphql", "grpc"]),
    from: z.enum(["repository", "url", "upload", "introspection", "reflection"]),
    repo: z.string().nullable(),
    path: z.string().nullable(),
    ref: z.string().nullable(),
    url: z.string().nullable(),
    network: z.string().nullable(),
  }),
]);

/** One `[environments.<name>]` table. */
const studioEnvironmentSchema = z.object({
  name: z.string(),
  sandbox: z.boolean(),
  url: z.string().nullable(),
  /** `cloud`, or `relay:<name>` for a server inside a private network. */
  network: z.string().nullable(),
  /** A vault reference such as `oxagen:credential/stripe-sandbox`, never a secret. */
  credential: z.string().nullable(),
});

/** How the gateway shapes one tools.toml key's calls and results. */
const studioShapingSchema = z.object({
  /** The tools.toml key. */
  tool: z.string(),
  /** Inputs that leave the schema. */
  hide: z.array(z.string()),
  /** Inputs set on every call, each value as JSON. */
  fixed: z.array(z.object({ name: z.string(), value: z.string() })),
  /** The result paths kept; empty keeps the whole result. */
  select: z.array(z.string()),
  /** The GraphQL selection set, for a GraphQL operation. */
  selection: z.string().nullable(),
});

/**
 * One server folder as Studio's server page reads it (#4678): list_studio_tools'
 * catalog, and the rest of the folder beside it.
 */
export const studioServerOutputSchema = studioToolsListOutputSchema.extend({
  /** The folder, such as `tools/servers/stripe`. */
  folder: z.string(),
  label: z.string(),
  description: z.string(),
  source: studioSourceSchema,
  /**
   * server.toml's `[auth]`. A server the local gateway runs has none, and
   * reads as mode `none`.
   */
  auth: z.object({
    mode: z.enum(["none", "service", "operator-oauth"]),
    /** oauth, bearer, basic or header; for OpenAPI, a `securitySchemes` key. */
    scheme: z.string().nullable(),
    /** A vault reference, never a secret. */
    credential: z.string().nullable(),
  }),
  environments: z.array(studioEnvironmentSchema),
  sync: z.object({
    schedule: z.enum(["on-change", "daily", "manual"]),
    /** When the last discovery finished, or null when it did not succeed or never ran. */
    lastAt: isoDateSchema.nullable(),
  }),
  /** Each tools.toml key's shaping, in the order tools.toml lists the keys. */
  shaping: z.array(studioShapingSchema),
});

/**
 * Read one server folder for Studio's server page (#4678): its server.toml
 * source, auth, environments, exposure and sync schedule, each tools.toml
 * key's shaping, and the same tool catalog `list_studio_tools` returns, all
 * from one read of the production branch.
 *
 * `list_studio_tools` returns the catalog alone, and `get_studio_draft`
 * returns only the edits Studio staged.
 */
export const toolStudioServerGet = registerCapability({
  name: "get_studio_server",
  domain: "tool",
  description:
    "Read one server folder on the steering repo's production branch: its source, auth mode, environments, exposure, sync schedule and last discovery, each tools.toml key's shaping, and the tool catalog list_studio_tools returns. A credential appears only as its vault reference.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "governance" },
  sensitivity: "medium",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z
    .object({
      /** The folder name under tools/servers/. */
      server: studioServerNameSchema,
    })
    .strict(),
  output: studioServerOutputSchema,
});

export type ToolStudioServerGetInput = z.output<typeof toolStudioServerGet.input>;
export type ToolStudioServerGetOutput = z.output<typeof toolStudioServerGet.output>;
