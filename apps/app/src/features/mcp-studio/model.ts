// What one Studio server page shows (#4678), and where each value comes from.
//
// Two sources meet here. The registry is recorded today: the server row
// (`list_mcp_servers`), the tool versions imported from it
// (`list_tool_versions`) and the kill switches (`list_kill_switches`). The
// Studio record is not: the server's steering folder (server.toml, tools.toml,
// the lock and the tests) and the tools discovery offered. That record arrives
// through `readStudioRecord` (seams.ts), which answers null until lanes M10
// and M11 write it. Every value only the record holds renders as not recorded,
// never as a zero or an empty list the record cannot back.
//
// The words mirror @oxagen/mcp-studio's contract (`mcp-server/v1`,
// `mcp-tools/v1`, lint's `Finding`): the same source types, transports,
// networks, auth modes and suggestion bases. The app does not depend on that
// package, so the vocabulary is restated here, with the TOML keys in
// camelCase (`registry_type` is `registryType`).
import type {
  KillSwitch,
  KillSwitchBoard,
  McpServer,
  ToolEgress,
  ToolRiskGrade,
  ToolSideEffect,
  ToolVersion,
} from "@/data/contracts/tools";

/** Why Studio suggested a classification (`suggest`'s `SuggestionBasis`). */
type SuggestionBasis =
  | "source_hint"
  | "annotations"
  | "http_method"
  | "graphql_operation"
  | "grpc_idempotency"
  | "fail_safe";

export type StudioClassification = {
  risk: ToolRiskGrade;
  sideEffect: ToolSideEffect;
  egress: ToolEgress;
  impacts: readonly string[];
  /** False while the values are Studio's suggestion and no person confirmed them. */
  confirmed: boolean;
  /** What the suggestion came from; null once a person set the values. */
  basis: SuggestionBasis | null;
};

/** How the gateway shapes a call and its result (tools.toml's shaping keys). */
type StudioShaping = {
  /** Inputs that leave the schema, so the model never sees them. */
  hide: readonly string[];
  /** Inputs the gateway fills with a fixed value. */
  fixed: readonly { name: string; value: string }[];
  /** The result paths kept; empty means the whole result. */
  select: readonly string[];
  /** The GraphQL selection set, for a GraphQL operation. */
  selection: string | null;
};

/** What agents' calls said about a tool over the recorded window. */
type StudioFeedback = {
  calls: number;
  schemaRejections: number;
  errorResults: number;
  retries: number;
  /** What reflections' `tool_feedback` said about the tool, newest first. */
  notes: readonly string[];
};

/** One tool as the Studio record holds it. */
type StudioRecordTool = {
  /** The tools.toml key, or the upstream name for a tool nobody imported. */
  name: string;
  imported: boolean;
  /** Tokens its definition adds to every model call; null until measured. */
  tokens: number | null;
  /** The description the source gives. */
  serverDescription: string | null;
  /** The MCP annotations the server set to true, such as `destructiveHint`. */
  annotations: readonly string[];
  classification: StudioClassification | null;
  /** The description agents see, when tools.toml replaces the source's. */
  description: string | null;
  shaping: StudioShaping | null;
  feedback: StudioFeedback | null;
};

/** The package types the local gateway runs (`REGISTRY_TYPES`). */
type StudioRegistryType = "npm" | "pypi" | "oci" | "nuget";

/** server.toml's `[source]`, one shape per source type. */
export type StudioSource =
  | {
      type: "remote";
      url: string;
      /** MCP's streamable HTTP transport; review refuses `sse` (ADR-211). */
      transport: "http";
      network: string | null;
    }
  | {
      type: "registry";
      /** The registry's URL. */
      registry: string;
      /** The entry's registry name, such as `io.github.github/github-mcp-server`. */
      server: string;
      version: string;
      network: string | null;
      /** The machine groups whose local gateway runs the package; empty for the remote. */
      machines: readonly string[];
      registryType: StudioRegistryType | null;
      /** Names of the environment variables passed through, never their values. */
      env: readonly string[];
    }
  | {
      type: "local";
      command: string;
      args: readonly string[];
      /** Names of the environment variables passed through, never their values. */
      env: readonly string[];
      machines: readonly string[];
    }
  | {
      type: "openapi" | "graphql" | "grpc";
      from: "repository" | "url" | "upload" | "introspection" | "reflection";
      /** `github.com/<owner>/<name>` for a repository source. */
      repo: string | null;
      path: string | null;
      ref: string | null;
      url: string | null;
      network: string | null;
    };

export type StudioSourceType = StudioSource["type"];
export type StudioAuthMode = "none" | "service" | "operator-oauth";

export type StudioEnvironment = {
  name: string;
  /** server.toml's `sandbox = true`. */
  sandbox: boolean;
  url: string | null;
  /** `cloud`, or `relay:<name>` for a server inside a private network. */
  network: string | null;
  /** A vault reference such as `oxagen:credential/stripe-sandbox`, never a secret. */
  credential: string | null;
};

/** The server's steering folder and its last discovery. */
export type StudioRecord = {
  /** The steering folder, such as `tools/servers/stripe`. */
  folder: string;
  source: StudioSource;
  auth: {
    mode: StudioAuthMode;
    /** oauth, bearer, basic or header; for OpenAPI, a `securitySchemes` key. */
    scheme: string | null;
    /** A vault reference, never a secret. */
    credential: string | null;
  };
  environments: readonly StudioEnvironment[];
  /** `definitionBudget` is server.toml's value, or the 8,000-token default. */
  exposure: { mode: "direct" | "search"; definitionBudget: number };
  sync: { schedule: "on-change" | "daily" | "manual"; lastAt: string | null };
  tools: readonly StudioRecordTool[];
};

/** One row of the Tools tab: the record's tool joined to its imported version. */
export type StudioTool = {
  name: string;
  imported: boolean;
  /** The imported version's `tlv_…` id; null for a tool not imported. */
  versionId: string | null;
  version: number | null;
  tokens: number | null;
  classification: StudioClassification | null;
  /** The description agents see: tools.toml's, else the version's. */
  description: string | null;
  serverDescription: string | null;
  annotations: readonly string[];
  shaping: StudioShaping | null;
  feedback: StudioFeedback | null;
  /**
   * The tool's kill switch: the one denying, else the newest one cleared, so
   * the page can say who turned it off or back on. Null when the tool has none.
   */
  killSwitch: KillSwitch | null;
};

export type StudioServerView = {
  server: McpServer;
  record: StudioRecord | null;
  /**
   * The server's name in the steering repo: its folder under tools/servers/.
   * A draft and a steering PR are keyed by it, and every Studio call names
   * the server by it. The record's folder when a record is read, else the
   * folder the registry row names. Null for a server no steering repo
   * defines, which is also when Review cannot run.
   */
  serverName: string | null;
  tools: readonly StudioTool[];
  /** The record's environments, or the one `default` a server without any has. */
  environments: readonly StudioEnvironment[];
  /** The environment every agent's calls go to; null when the record breaks the rule. */
  agentEnvironment: string | null;
  /** The server's kill switch, picked as a tool's is. */
  killSwitch: KillSwitch | null;
};

/**
 * The tool name inside a version's capability, `mcp.<server>.<tool>`; the
 * slug when the capability has no tool part.
 */
function toolNameOf(version: ToolVersion): string {
  const parts = version.capability.split(".");
  return parts.length >= 3 ? parts.slice(2).join(".") : version.slug;
}

/** A classified version's values, which a person set when they classified it. */
function classificationOf(version: ToolVersion): StudioClassification | null {
  if (version.classification === null) return null;
  return {
    risk: version.riskGrade,
    sideEffect: version.classification.sideEffect,
    egress: version.classification.egress,
    impacts: version.classification.impacts,
    confirmed: true,
    basis: null,
  };
}

/**
 * The switch that speaks for a target: one that denies, else the newest by
 * flip time. A target can carry several rows at two scopes, and the one that
 * denies is the one the page must show.
 */
function switchOf(
  board: KillSwitchBoard | null,
  kind: "tool_server" | "tool_version",
  ref: string,
): KillSwitch | null {
  const rows = (board?.switches ?? []).filter(
    (s) => s.target.kind === kind && s.target.ref === ref,
  );
  const on = rows.find((s) => s.on);
  if (on !== undefined) return on;
  let newest: KillSwitch | null = null;
  for (const row of rows) {
    if (
      newest === null ||
      Date.parse(row.flippedAt) > Date.parse(newest.flippedAt)
    ) {
      newest = row;
    }
  }
  return newest;
}

/**
 * The spec's environment rule: a server with no environments has one,
 * `default`, at the server's own endpoint.
 */
function environmentsOf(
  server: McpServer,
  record: StudioRecord | null,
): readonly StudioEnvironment[] {
  if (record !== null && record.environments.length > 0) {
    return record.environments;
  }
  return [
    {
      name: "default",
      sandbox: false,
      url: server.endpointUrl,
      network: null,
      credential: record?.auth.credential ?? null,
    },
  ];
}

/**
 * The environment agents call (the contract's `agentEnvironment`): the only
 * one, or the one marked sandbox when there are several. A record that marks
 * none or two answers null; the schema check refuses it, and the page says so
 * rather than guessing.
 */
function agentEnvironmentOf(
  environments: readonly StudioEnvironment[],
): string | null {
  const [only] = environments;
  if (environments.length === 1 && only !== undefined) return only.name;
  const marked = environments.filter((env) => env.sandbox);
  const [sandbox] = marked;
  return marked.length === 1 && sandbox !== undefined ? sandbox.name : null;
}

/**
 * The Shared contract's server name rule and the name built-in tools take,
 * restated from @oxagen/oxagen's steering-repo/names.ts. The app's layer
 * test (src/test/arch/layers.ts) admits no import from that module here.
 */
const SERVER_NAME_PATTERN = /^[a-z][a-z0-9_]{0,23}$/;
const BUILTIN_SERVER = "builtin";

/**
 * The server's name in the steering repo, read from the record's folder
 * (`tools/servers/stripe` is `stripe`). Null when there is no record, or when
 * the folder's last part breaks the Shared contract's server name rule or is
 * the name built-in tools use, since no draft could be saved under it.
 */
/**
 * The folder name the Studio calls name the server by: the record's folder,
 * else the one the registry row names for a server a steering repo defines.
 * A name that is not a server name, or is the built-in server's, is none.
 */
function studioServerName(
  server: McpServer,
  record: StudioRecord | null,
): string | null {
  const name =
    record === null
      ? server.steeringName
      : (record.folder.replace(/\/+$/, "").split("/").at(-1) ?? "");
  if (name === null) return null;
  if (!SERVER_NAME_PATTERN.test(name) || name === BUILTIN_SERVER) return null;
  return name;
}

/**
 * Join the registry to the Studio record. A version with no record row is
 * still an imported tool, and a record row with no version is one discovery
 * offered and nobody imported. Imported tools come first, then by name.
 */
export function buildStudioView({
  server,
  versions,
  board,
  record,
}: {
  server: McpServer;
  versions: readonly ToolVersion[];
  /** The kill switch board, or null when it did not load. */
  board: KillSwitchBoard | null;
  record: StudioRecord | null;
}): StudioServerView {
  const own = versions.filter((v) => v.serverId === server.id);
  const byName = new Map(own.map((v) => [toolNameOf(v), v]));
  const seen = new Set<string>();
  const tools: StudioTool[] = (record?.tools ?? []).map((row) => {
    seen.add(row.name);
    const version = byName.get(row.name);
    return {
      name: row.name,
      imported: row.imported || version !== undefined,
      versionId: version?.id ?? null,
      version: version?.version ?? null,
      tokens: row.tokens,
      classification:
        row.classification ??
        (version === undefined ? null : classificationOf(version)),
      description: row.description ?? version?.description ?? null,
      serverDescription: row.serverDescription,
      annotations: row.annotations,
      shaping: row.shaping,
      feedback: row.feedback,
      killSwitch:
        version === undefined
          ? null
          : switchOf(board, "tool_version", version.id),
    };
  });
  for (const [name, version] of byName) {
    if (seen.has(name)) continue;
    tools.push({
      name,
      imported: true,
      versionId: version.id,
      version: version.version,
      tokens: null,
      classification: classificationOf(version),
      description: version.description,
      serverDescription: null,
      annotations: [],
      shaping: null,
      feedback: null,
      killSwitch: switchOf(board, "tool_version", version.id),
    });
  }
  tools.sort((a, b) =>
    a.imported === b.imported
      ? a.name.localeCompare(b.name)
      : a.imported
        ? -1
        : 1,
  );
  const environments = environmentsOf(server, record);
  return {
    server,
    record,
    serverName: studioServerName(server, record),
    tools,
    environments,
    agentEnvironment: agentEnvironmentOf(environments),
    killSwitch: switchOf(board, "tool_server", server.id),
  };
}

/**
 * The definition tokens a set of imported tools adds to every model call: the
 * sum of each tool's measured tokens when every one has a measurement, and
 * null when any is unmeasured.
 */
export function sumTokens(
  tools: readonly Pick<StudioTool, "tokens">[],
): number | null {
  let sum = 0;
  for (const tool of tools) {
    if (tool.tokens === null) return null;
    sum += tool.tokens;
  }
  return sum;
}
