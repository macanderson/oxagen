// Row → view-model mappers for the Tools page (plan §3.1 Tools rows, lane A4).
//
// Pure functions: rows in (typed from the drizzle `$inferSelect` shapes of the
// tables the Postgres store reads), view-model drafts out. A draft carries
// `null` wherever today's stores record nothing the view model can hold, or
// hold something outside the spec vocabulary. `settle` then parses the drafts
// through the view-model schema: a field the schema will not accept as null
// makes the whole read "not recorded yet", never a fabricated zero, an empty
// tag list or a guessed enum. When a contract widens a field to nullable (the
// promote list in the PR), the same draft parses and the read lights up with
// no adapter change.
import { createHash } from "node:crypto";
import type { schema } from "@oxagen/database";
import type { z } from "zod";
import {
  type Connection,
  type ConnectionKind,
  type KillSwitch,
  Risk,
  type SwitchLevel,
  type ToolServer,
  type ToolVersion,
} from "@/data/contracts";

type McpServerRow = typeof schema.mcpServers.$inferSelect;
type McpCredentialRow = typeof schema.mcpCredentials.$inferSelect;
type ToolRow = typeof schema.tools.$inferSelect;
type ToolVersionRow = typeof schema.toolVersions.$inferSelect;
type SnapshotRow = typeof schema.mcpToolSnapshots.$inferSelect;
type SourceConnectionRow = typeof schema.sourceConnections.$inferSelect;
type EmergencyDenyRow = typeof schema.emergencyDenies.$inferSelect;

// ---- Ids ---------------------------------------------------------------------

/**
 * `ServerId` is a URL segment (`^[a-z0-9][a-z0-9-]*$`); an `mcp.mcp_servers`
 * public id is `mcs_<crockford>`. The underscore becomes a hyphen, reversibly
 * (the body is lowercase base-32 and never contains either character), so a
 * write can recover the public id with `serverPublicIdOf`.
 */
export function serverIdOf(publicId: string): string {
  return publicId.replace("_", "-");
}

export function serverPublicIdOf(serverId: string): string {
  return serverId.replace("-", "_");
}

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

// ---- Tool servers (`mcp.mcp_servers` + `mcp.tool_snapshots` + `mcp.credentials`)

export type ServerSource = {
  server: Pick<
    McpServerRow,
    | "publicId"
    | "name"
    | "transportType"
    | "endpointUrl"
    | "healthStatus"
    | "discoveredTools"
    | "enabled"
  >;
  /** Distinct descriptors captured for the server, and the newest capture. */
  snapshots: { descriptorCount: number; lastCapturedAt: Date | null };
  /** The `mcp.credentials` row installed for the server's listing, if any. */
  credentialPublicId: McpCredentialRow["publicId"] | null;
};

export type ToolServerDraft = Omit<
  ToolServer,
  "transport" | "health" | "pendingSchemaCount"
> & {
  /** `sse` has no word in the spec's transport vocabulary. */
  transport: ToolServer["transport"] | null;
  /** `unknown` (never health-checked) cannot read as `ok`. */
  health: ToolServer["health"] | null;
  /** No observed-schema store exists (§3.1 Tools · observed schemas ❌). */
  pendingSchemaCount: null;
};

const TRANSPORT: Record<string, ToolServer["transport"]> = {
  "streamable-http": "streamable_http",
  stdio: "stdio",
};

/**
 * `unreachable` reads as `degraded`, the vocabulary's only non-ok value: it
 * never claims more health than was recorded. `unknown` has no honest word.
 */
const HEALTH: Record<string, ToolServer["health"]> = {
  healthy: "ok",
  degraded: "degraded",
  unreachable: "degraded",
};

export function toToolServer(src: ServerSource): ToolServerDraft {
  const { server, snapshots } = src;
  const tools = server.discoveredTools;
  return {
    id: serverIdOf(server.publicId),
    name: server.name,
    // Every row of mcp.mcp_servers is an MCP server.
    kind: "mcp",
    transport: TRANSPORT[server.transportType] ?? null,
    endpoint: server.endpointUrl,
    // `discovered_tools` is the server's current tools/list (NOT NULL, default '[]').
    toolCount: Array.isArray(tools) ? tools.length : Number.NaN,
    versionCount: snapshots.descriptorCount,
    // Emergency denies name capabilities, never a server, so no server row can
    // be recorded as `killed` today; `enabled` is the recorded state.
    status: server.enabled ? "active" : "disabled",
    health: HEALTH[server.healthStatus] ?? null,
    lastImportAt: snapshots.lastCapturedAt?.toISOString() ?? null,
    connectionId: src.credentialPublicId,
    pendingSchemaCount: null,
  };
}

// ---- Tool versions (`agent.tools` × `agent.tool_versions`, `mcp.tool_snapshots`)

export type ToolVersionDraft = Omit<
  ToolVersion,
  | "name"
  | "serverId"
  | "sideEffect"
  | "egress"
  | "consequenceTags"
  | "risk"
  | "credential"
  | "beltCount"
  | "calls30d"
> & {
  name: string | null;
  serverId: string | null;
  risk: ToolVersion["risk"] | null;
  sideEffect: ToolVersion["sideEffect"] | null;
  egress: null;
  consequenceTags: null;
  credential: {
    connectionKind: ConnectionKind | null;
    downscope: null;
  };
  beltCount: null;
  calls30d: null;
};

/** Fields no store records for any tool version today (spec §6.9, App. A.5). */
const UNCLASSIFIED = {
  egress: null,
  consequenceTags: null,
  price: null,
  credential: { connectionKind: null, downscope: null },
  measures: {
    amount: null,
    currency: null,
    counterparty: null,
    idempotencyKey: null,
  },
  // Derivable later: iam.role_grants for belts, ClickHouse tool_invocations for calls.
  beltCount: null,
  calls30d: null,
} as const;

export type DeclaredToolSource = {
  tool: Pick<ToolRow, "slug" | "source">;
  version: Pick<
    ToolVersionRow,
    "versionNumber" | "riskGrade" | "readOnly" | "checksum"
  >;
};

export function toDeclaredToolVersion(
  src: DeclaredToolSource,
): ToolVersionDraft {
  const { tool, version } = src;
  const risk = Risk.safeParse(version.riskGrade);
  return {
    ...UNCLASSIFIED,
    name: TOOL_NAME.test(tool.slug) ? tool.slug : null,
    version: String(version.versionNumber),
    // agent.tools carries no server: the declaration is not bound to one.
    serverId: null,
    risk: risk.success ? risk.data : null,
    // read_only=false does not say whether a write is reversible.
    sideEffect: version.readOnly ? "read" : null,
    schemaOrigin: tool.source === "mcp" ? "imported" : "declared",
    // SHA-256 over the canonical manifest, which carries the input schema.
    schemaDigest: `sha256:${version.checksum}`,
  };
}

export type ImportedToolSource = {
  serverPublicId: McpServerRow["publicId"];
  toolName: SnapshotRow["toolName"];
  schemaJson: SnapshotRow["schemaJson"];
  /** When this exact descriptor was first captured. */
  firstCapturedAt: Date;
};

/** JSON with object keys sorted at every depth, so equal descriptors hash equal. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function descriptorDigest(schemaJson: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(schemaJson)).digest("hex")}`;
}

/**
 * One version per distinct descriptor a server advertised for a tool, numbered
 * from 1 in order of first capture. Re-enabling a server re-captures the same
 * descriptor; that is the same version, not a new one.
 */
export function toImportedToolVersions(
  sources: readonly ImportedToolSource[],
): ToolVersionDraft[] {
  const byTool = new Map<string, Map<string, ImportedToolSource>>();
  const ordered = [...sources].sort(
    (a, b) => a.firstCapturedAt.getTime() - b.firstCapturedAt.getTime(),
  );
  for (const src of ordered) {
    const key = `${src.serverPublicId} ${src.toolName}`;
    const versions = byTool.get(key) ?? new Map<string, ImportedToolSource>();
    const digest = descriptorDigest(src.schemaJson);
    if (!versions.has(digest)) versions.set(digest, src);
    byTool.set(key, versions);
  }
  return [...byTool.values()].flatMap((versions) =>
    [...versions.entries()].map(([digest, src], i) => ({
      ...UNCLASSIFIED,
      name: TOOL_NAME.test(src.toolName) ? src.toolName : null,
      version: String(i + 1),
      serverId: serverIdOf(src.serverPublicId),
      // MCP tools/list carries no risk grade or side-effect class.
      risk: null,
      sideEffect: null,
      schemaOrigin: "imported" as const,
      schemaDigest: digest,
    })),
  );
}

// ---- Connections (`ingestion.source_connections`, `mcp.credentials`) ---------

export type ConnectionDraft = Omit<
  Connection,
  | "kind"
  | "name"
  | "ownerId"
  | "reviewedOn"
  | "reviewOn"
  | "grants30d"
  | "status"
  | "downscope"
> & {
  kind: ConnectionKind | null;
  name: string | null;
  ownerId: string | null;
  /** No review schedule is recorded for any connection today. */
  reviewedOn: null;
  reviewOn: null;
  /** No credential-grant store (App. A.5 `tools.credential_grants`) exists. */
  grants30d: null;
  status: Connection["status"] | null;
  downscope: null;
};

const UNREVIEWED = {
  reviewedOn: null,
  reviewOn: null,
  grants30d: null,
  requiresMandate: null,
  downscope: null,
} as const;

/** `ingestion` AuthScheme → `tools.connections.kind`; the rest have no word. */
const SOURCE_KIND: Record<string, ConnectionKind> = {
  oauth2_authorization_code: "oauth",
  oauth2_client_credentials: "oauth",
  api_key: "api_key",
  api_key_secret: "api_key",
  bearer_token: "api_key",
  aws_cross_account_role: "cloud_role",
};

/** Only `connected` says the credential works; setup, pause and error have no word. */
const SOURCE_STATUS: Record<string, Connection["status"]> = {
  connected: "active",
};

export type SourceConnectionSource = {
  connection: Pick<
    SourceConnectionRow,
    "publicId" | "displayName" | "authScheme" | "status"
  >;
  ownerPublicId: string | null;
};

export function toSourceConnection(
  src: SourceConnectionSource,
): ConnectionDraft {
  const { connection } = src;
  return {
    ...UNREVIEWED,
    id: connection.publicId,
    kind: SOURCE_KIND[connection.authScheme] ?? null,
    name: connection.displayName,
    ownerId: src.ownerPublicId,
    // A data-source connection feeds ingestion; it backs no tool server.
    serverIds: [],
    status: SOURCE_STATUS[connection.status] ?? null,
  };
}

const CREDENTIAL_KIND: Record<string, ConnectionKind> = {
  oauth: "oauth",
  secret: "api_key",
};

const CREDENTIAL_STATUS: Record<string, Connection["status"]> = {
  active: "active",
  needs_reauth: "expired",
  revoked: "revoked",
};

export type McpCredentialSource = {
  credential: Pick<McpCredentialRow, "publicId" | "authKind" | "status">;
  /** The live server installed from the same listing in the workspace. */
  server: Pick<McpServerRow, "publicId" | "name"> | null;
  ownerPublicId: string | null;
};

export function toMcpCredentialConnection(
  src: McpCredentialSource,
): ConnectionDraft {
  const { credential, server } = src;
  return {
    ...UNREVIEWED,
    id: credential.publicId,
    kind: CREDENTIAL_KIND[credential.authKind] ?? null,
    name: server?.name ?? null,
    ownerId: src.ownerPublicId,
    serverIds: server ? [serverIdOf(server.publicId)] : [],
    status: CREDENTIAL_STATUS[credential.status] ?? null,
  };
}

// ---- Kill switches (`iam.emergency_denies`) ----------------------------------

export type KillSwitchSource = {
  deny: Pick<
    EmergencyDenyRow,
    | "publicId"
    | "denyKind"
    | "capabilityId"
    | "resourceScopeDigest"
    | "principalId"
    | "reason"
    | "active"
    | "activatedAt"
    | "deactivatedAt"
  >;
  /** Who activated the deny (created_by) and who deactivated it (updated_by). */
  activatedByPublicId: string | null;
  deactivatedByPublicId: string | null;
};

export type KillSwitchDraft = Omit<KillSwitch, "level"> & {
  level: SwitchLevel | null;
};

/**
 * An emergency deny names one capability (an agent tool; today's kernel keeps
 * one version of each) or one resource scope. A deny narrowed to one principal
 * stops that capability for that principal only; the switch vocabulary has no
 * level that says so without overstating its reach, and neither does it for a
 * resource-scope digest.
 */
function levelOf(src: KillSwitchSource): SwitchLevel | null {
  if (src.deny.principalId !== null) return null;
  return src.deny.denyKind === "capability" ? "tool_version" : null;
}

export function toKillSwitch(src: KillSwitchSource): KillSwitchDraft {
  const { deny } = src;
  const level = levelOf(src);
  return {
    id: deny.publicId,
    level,
    target: deny.capabilityId ?? deny.resourceScopeDigest ?? "",
    on: deny.active,
    headline: level === "class",
    flippedById: deny.active
      ? src.activatedByPublicId
      : src.deactivatedByPublicId,
    flippedAt:
      (deny.active ? deny.activatedAt : deny.deactivatedAt)?.toISOString() ??
      null,
    reason: deny.reason,
    // Nothing counts what a deny stops when it is read.
    blastRadius: {
      agents: null,
      toolVersions: null,
      mandates: null,
      runsInFlight: null,
      grants24h: null,
    },
  };
}

// ---- Settling drafts through the view-model schema ---------------------------

export type Settled<T> =
  | { kind: "ok"; value: T[] }
  /** Dotted paths (array indexes dropped) the view model will not take as null. */
  | { kind: "unrecorded"; paths: string[] }
  /** A value the mapper produced that the schema rejects: a mapper defect. */
  | { kind: "mismatch"; paths: string[] };

function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  return cur;
}

function fieldPath(path: readonly PropertyKey[]): string {
  return path
    .filter((k) => typeof k !== "number")
    .map(String)
    .join(".");
}

const unique = (xs: string[]) => [...new Set(xs)].sort();

/**
 * Parse every draft through `view`. Succeeds with the parsed rows; otherwise
 * reports whether every rejection sits on a field the mapper left null
 * (unrecorded) or some rejection is a value the mapper produced (mismatch).
 */
export function settle<T>(
  view: z.ZodType<T>,
  drafts: readonly unknown[],
): Settled<T> {
  const value: T[] = [];
  const nulls: string[] = [];
  const wrong: string[] = [];
  for (const draft of drafts) {
    const parsed = view.safeParse(draft);
    if (parsed.success) {
      value.push(parsed.data);
      continue;
    }
    for (const issue of parsed.error.issues) {
      const target = valueAt(draft, issue.path) === null ? nulls : wrong;
      target.push(fieldPath(issue.path));
    }
  }
  if (wrong.length > 0) return { kind: "mismatch", paths: unique(wrong) };
  if (nulls.length > 0) return { kind: "unrecorded", paths: unique(nulls) };
  return { kind: "ok", value };
}
