// migrate.ts: move a workspace's connected MCP servers into its steering repo.
//
// Each server connected the old way becomes a folder under tools/servers/,
// holding server.toml, tools.toml, and tools.lock.json. migrate() opens the
// folders as steering PRs and names each moved row's folder in
// mcp.mcp_servers.steering_name. When a batch merges, the first publish after
// it takes each row over (project.ts), so the row keeps its id, its tool
// snapshots, and the consents keyed on it.
//
// Which rows move (the coordinator's rule for M13, #4478):
//
// - Every live, enabled, legacy row whose transport is streamable-http
//   moves. A plugin row whose install is disabled or deleted counts as
//   disabled.
// - A stdio row stays a legacy row. So does an sse row, because review
//   refuses the older HTTP+SSE transport (ADR-211), and so does any other
//   transport. Each is listed in every batch's PR body under "Servers not
//   moved", with its name and the reason. So is a remote row migrate cannot
//   write a valid folder for, such as a header row whose header name it
//   cannot read.
// - A disabled row is skipped and not listed.
// - A row that already names a folder is in an open or merged batch, and is
//   skipped. When the caller passes the folders on the steering repo's main
//   branch and the row's folder is not among them, its batch closed unmerged,
//   and the row is planned again under the same name. Pass existingFolders
//   only when no batch is open, or the open batch is planned twice.
//
// Batches hold whole server folders and never split one. Each batch is its
// own steering PR of at most 299 files, and its body gives the batch number
// and the total. Registry writes switch to steering PRs only after the last
// batch merges (steeringWriter in @oxagen/agent/runtime/steering-pr).
//
// createServerFolderWriter() builds the same folders one server at a time for
// the direct paths (agent.mcp.register, plugin.set_enabled, import_tools) once
// that switch is on. It adds a proposed row's folder, or adds pinned tools to
// a steering server's tools.toml and lock.
//
// Each tool's folder entry carries today's classification. A tool with no
// valid classification is written as risk high (or its declared grade when
// that is higher), side effect write, and egress third_party, and the PR body
// lists it for review. The lock pins each tool's pinned snapshot, or the
// active version's schema when the tool has no snapshot. M4's lock() is not
// built, so the lock is built here from the contract's hash functions.
//
// This file stays out of the handlers barrel, as project.ts does.

import { isUniqueViolation, schema, withTenantDb } from "@oxagen/database";
import {
  definitionHash,
  formatJson,
  fromCodeClassification,
  lockedMcpTool,
  mcpToolSchema,
  parseLock,
  parseServerToml,
  parseToolsToml,
  upstreamHash,
  type LockedMcpTool,
  type McpTool,
  type ServerAuth,
  type ToolsEntry,
} from "@oxagen/mcp-studio";
import { decryptMcpAuthConfig } from "@oxagen/agent/runtime/mcp-server-auth-crypto";
import { readLatestPinnedDescriptors } from "@oxagen/agent/runtime/mcp-snapshots";
import {
  MOVABLE_TRANSPORTS,
  STEERING_PR_FILES_MAX,
  SteeringPrUnavailableError,
  steeringPrOpener,
  type AddServerRequest,
  type AddToolsRequest,
  type OpenedSteeringPr,
  type ServerFolderWriter,
  type SteeringPrFile,
  type SteeringPrOpener,
  type WorkspaceScope,
} from "@oxagen/agent/runtime/steering-pr";
import {
  BUILTIN_SERVER,
  TOOL_NAME_MAX,
  TOOL_SEPARATOR,
  credentialRef,
  toolName,
} from "@oxagen/oxagen/steering-repo/names";
import {
  serverTomlPath,
  toolsLockPath,
  toolsTomlPath,
} from "@oxagen/oxagen/steering-repo/paths";
import { schemaDirective } from "@oxagen/oxagen/steering-repo/schema-ids";
import {
  impactSchema,
  toolClassificationSchema,
  toolRiskGradeSchema,
  unionImpacts,
  type ToolRiskGrade,
} from "@oxagen/oxagen/contracts/tool.classification";
import { HandlerError } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { stringify } from "smol-toml";
import { logger } from "../logger";

/** The capability a migration reads and writes the registry under. */
export const MIGRATE_CAPABILITY = "migrate_tool_servers";

const FOLDER_MAX = 24;
const TOOL_KEY_LIMIT = TOOL_NAME_MAX - 1 - TOOL_SEPARATOR.length;
const UPSTREAM_NAME_MAX = 128;
const IMPACTS_MAX = 32;
const LABEL_MAX = 80;
/** GitHub refuses a PR body over 65,536 characters. */
const BODY_MAX = 60_000;
const RISK_ORDER: readonly ToolRiskGrade[] = ["low", "medium", "high", "critical"];

// ── What the planner reads ──────────────────────────────────────────────────

export interface MigrationServer {
  id: string;
  name: string;
  transportType: string;
  endpointUrl: string;
  authStrategy: string;
  /** plugin.installed_plugins.auth_kind for a plugin row. Null for a standalone row. */
  authKind: string | null;
  orgListingId: string | null;
  /** Whether the linked install is enabled and live. Null for a standalone row. */
  installActive: boolean | null;
  /** The header names a header row's auth_config holds. Null when they could not be read. */
  headerNames: readonly string[] | null;
  enabled: boolean;
  origin: string;
  steeringName: string | null;
  deletedAt: Date | null;
}

export interface MigrationToolVersion {
  inputSchema: unknown;
  riskGrade: string;
  impacts: readonly string[] | null;
  classification: unknown;
  classifiedRiskGrade: string | null;
}

export interface MigrationTool {
  serverId: string;
  /** The server's own name for the tool. */
  name: string;
  description: string | null;
  enabled: boolean;
  /** The active version, or null when the tool has none. */
  version: MigrationToolVersion | null;
}

/** One pinned tools/list entry from mcp.tool_snapshots. */
export interface MigrationDescriptor {
  serverId: string;
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
}

export interface MigrationInput {
  /** Every live row in the workspace, steering rows included. */
  servers: readonly MigrationServer[];
  /** The live MCP tool rows of those servers, enabled or not. */
  tools: readonly MigrationTool[];
  descriptors: readonly MigrationDescriptor[];
  /** The folders under tools/servers/ on the steering repo's main branch. */
  existingFolders?: readonly string[];
}

// ── What the planner returns ────────────────────────────────────────────────

export interface PlannedFolder {
  folder: string;
  serverId: string;
  label: string;
  toolCount: number;
  /** Full names of the tools written with the unclassified defaults. */
  unclassified: string[];
  files: SteeringPrFile[];
}

export interface ServerNotMoved {
  name: string;
  reason: string;
}

export interface ToolNotMoved {
  server: string;
  tool: string;
  reason: string;
}

export interface MigrationBatch {
  /** 1-based. */
  index: number;
  total: number;
  folders: PlannedFolder[];
  files: SteeringPrFile[];
}

export interface MigrationPlan {
  batches: MigrationBatch[];
  notMoved: ServerNotMoved[];
  toolsNotMoved: ToolNotMoved[];
}

// ── Names ───────────────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function fit(base: string, max: number): string {
  return base.slice(0, max).replace(/_+$/, "");
}

/** A lowercase name that starts with a letter and fits max, from any text. */
function nameFrom(text: string, fallback: string, prefix: string, max: number): string {
  let base = slugify(text);
  if (base === "") base = fallback;
  if (!/^[a-z]/.test(base)) base = `${prefix}${base}`;
  return fit(base, max);
}

/** base, or base_2, base_3, and so on, cut so the result still fits max. */
function unique(base: string, max: number, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `_${n}`;
    const candidate = `${fit(base, max - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The folder's credential reference. A placeholder: the secret stays on the row. */
function credentialFor(folder: string): string {
  return credentialRef(folder.replace(/_/g, "-"));
}

// ── Auth ────────────────────────────────────────────────────────────────────

type AuthResult = { ok: true; auth: ServerAuth } | { ok: false; reason: string };

function authFor(server: MigrationServer, folder: string): AuthResult {
  const credential = credentialFor(folder);
  if (server.orgListingId !== null) {
    if (server.authKind === "oauth") {
      return { ok: true, auth: { mode: "service", scheme: "oauth", credential } };
    }
    if (server.authStrategy === "none") return { ok: true, auth: { mode: "none" } };
    return { ok: true, auth: { mode: "service", scheme: "bearer", credential } };
  }
  switch (server.authStrategy) {
    case "none":
      return { ok: true, auth: { mode: "none" } };
    case "bearer":
      return { ok: true, auth: { mode: "service", scheme: "bearer", credential } };
    case "header": {
      const names = server.headerNames;
      if (names === null) {
        return { ok: false, reason: "its auth header name could not be read." };
      }
      if (names.length !== 1) {
        return {
          ok: false,
          reason: `it sends ${names.length} auth headers, and a server folder names one.`,
        };
      }
      return {
        ok: true,
        auth: { mode: "service", scheme: "header", header: names[0] as string, credential },
      };
    }
    default:
      return { ok: false, reason: `its auth strategy ${server.authStrategy} has no server.toml form.` };
  }
}

// ── Tools ───────────────────────────────────────────────────────────────────

interface ToolSource {
  upstreamName: string;
  description: string | null;
  inputSchema: unknown;
  version: MigrationToolVersion | null;
}

type Classified = { entry: ToolsEntry; classified: boolean } | { reason: string };

function validImpacts(impacts: readonly string[] | null): string[] {
  return [...new Set((impacts ?? []).filter((t) => impactSchema.safeParse(t).success))].sort();
}

function classify(version: MigrationToolVersion | null): Classified {
  const declared = version === null ? null : toolRiskGradeSchema.safeParse(version.riskGrade);
  if (version !== null) {
    const risk = toolRiskGradeSchema.safeParse(version.classifiedRiskGrade ?? version.riskGrade);
    const classification = toolClassificationSchema.safeParse(version.classification);
    if (risk.success && classification.success) {
      const impacts = unionImpacts({ impacts: version.impacts, classification: classification.data });
      const kept = impacts.filter((t) => impactSchema.safeParse(t).success);
      if (kept.length > IMPACTS_MAX) {
        return { reason: `it carries ${kept.length} impacts, over the limit of ${IMPACTS_MAX}.` };
      }
      return {
        entry: fromCodeClassification(risk.data, { ...classification.data, impacts: kept }),
        classified: true,
      };
    }
  }
  const impacts = validImpacts(version?.impacts ?? null);
  if (impacts.length > IMPACTS_MAX) {
    return { reason: `it carries ${impacts.length} impacts, over the limit of ${IMPACTS_MAX}.` };
  }
  const floor: ToolRiskGrade =
    declared?.success && RISK_ORDER.indexOf(declared.data) > RISK_ORDER.indexOf("high")
      ? declared.data
      : "high";
  const entry: ToolsEntry = { ...UNCLASSIFIED, risk: floor };
  if (impacts.length > 0) entry.impacts = impacts;
  return { entry, classified: false };
}

/** The tools a server serves today: its enabled tool rows, and pinned tools no row covers. */
function toolSources(
  server: MigrationServer,
  tools: readonly MigrationTool[],
  descriptors: readonly MigrationDescriptor[],
): ToolSource[] {
  const pinned = new Map<string, MigrationDescriptor>();
  for (const d of descriptors) {
    if (d.serverId !== server.id) continue;
    const key = d.name.trim().toLowerCase();
    if (!pinned.has(key)) pinned.set(key, d);
  }
  const exact = new Map<string, MigrationDescriptor>();
  for (const d of pinned.values()) exact.set(d.name, d);

  const out: ToolSource[] = [];
  const covered = new Set<string>();
  const rows = tools
    .filter((t) => t.serverId === server.id)
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const row of rows) {
    const name = row.name.trim();
    const key = name.toLowerCase();
    if (covered.has(key)) continue;
    covered.add(key);
    // A disabled row stays off: carrying it would turn it back on.
    if (!row.enabled) continue;
    const d = exact.get(name) ?? pinned.get(key);
    out.push({
      upstreamName: d?.name ?? name,
      description: d ? d.description : row.description,
      inputSchema: d ? d.inputSchema : row.version?.inputSchema,
      version: row.version,
    });
  }
  const loose = [...pinned.entries()]
    .filter(([key]) => !covered.has(key))
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [, d] of loose) {
    out.push({
      upstreamName: d.name,
      description: d.description,
      inputSchema: d.inputSchema,
      version: null,
    });
  }
  return out;
}

// ── Files ───────────────────────────────────────────────────────────────────

function tomlFile(id: "mcp-server/v1" | "mcp-tools/v1", value: Record<string, unknown>): string {
  return `${schemaDirective(id)}\n${stringify(value)}`;
}

type FolderResult =
  | { ok: true; folder: PlannedFolder; toolsNotMoved: ToolNotMoved[] }
  | { ok: false; reason: string; toolsNotMoved: ToolNotMoved[] };

function firstIssue(file: string, issues: readonly { field: string | null; message: string }[]): string {
  const issue = issues[0];
  if (!issue) return `its ${file} did not validate.`;
  return `its ${file} did not validate: ${issue.field ? `${issue.field}: ` : ""}${issue.message}`;
}

const MOVED_DESCRIPTION = "An MCP server moved from the workspace's connected servers.";
const ADDED_DESCRIPTION = "An MCP server connected in Oxagen.";

/** A tool's tools.lock.json entry, pinned to the upstream descriptor. */
function lockEntry(folder: string, key: string, tool: McpTool): Record<string, unknown> {
  const upstream: LockedMcpTool = lockedMcpTool(tool);
  return {
    definition_hash: definitionHash({
      name: toolName(folder, key),
      ...(upstream.description === undefined ? {} : { description: upstream.description }),
      inputSchema: upstream.inputSchema,
      ...(upstream.outputSchema === undefined ? {} : { outputSchema: upstream.outputSchema }),
    }),
    upstream,
    upstream_hash: upstreamHash(upstream),
    version: 1,
  };
}

/** The unclassified defaults: risk high, side effect write, egress third_party. */
const UNCLASSIFIED: ToolsEntry = { risk: "high", side_effect: "write", egress: "third_party" };

function buildFolder(
  server: MigrationServer,
  folder: string,
  input: Pick<MigrationInput, "tools" | "descriptors">,
  description: string = MOVED_DESCRIPTION,
): FolderResult {
  const toolsNotMoved: ToolNotMoved[] = [];
  const url = new URL(server.endpointUrl);
  if (url.search !== "") {
    return {
      ok: false,
      reason:
        "its URL has a query string, which may carry a credential, and a server folder's URL is committed to git.",
      toolsNotMoved,
    };
  }
  const auth = authFor(server, folder);
  if (!auth.ok) return { ok: false, reason: auth.reason, toolsNotMoved };

  const keyMax = Math.min(TOOL_KEY_LIMIT, TOOL_NAME_MAX - TOOL_SEPARATOR.length - folder.length);
  const keys = new Set<string>();
  const entries: Record<string, ToolsEntry> = {};
  const locked: Record<string, unknown> = {};
  const unclassified: string[] = [];

  for (const source of toolSources(server, input.tools, input.descriptors)) {
    if (source.upstreamName.length > UPSTREAM_NAME_MAX) {
      toolsNotMoved.push({
        server: folder,
        tool: source.upstreamName.slice(0, 64),
        reason: `its name is over ${UPSTREAM_NAME_MAX} characters.`,
      });
      continue;
    }
    const parsed = mcpToolSchema.safeParse({
      name: source.upstreamName,
      ...(source.description ? { description: source.description } : {}),
      inputSchema: source.inputSchema,
    });
    if (!parsed.success) {
      toolsNotMoved.push({
        server: folder,
        tool: source.upstreamName,
        reason: "its input schema is not a JSON Schema object.",
      });
      continue;
    }
    const verdict = classify(source.version);
    if ("reason" in verdict) {
      toolsNotMoved.push({ server: folder, tool: source.upstreamName, reason: verdict.reason });
      continue;
    }
    const key = unique(nameFrom(source.upstreamName, "tool", "t_", keyMax), keyMax, keys);
    keys.add(key);
    entries[key] = {
      ...(key === source.upstreamName ? {} : { upstream: source.upstreamName }),
      ...verdict.entry,
    };
    locked[key] = lockEntry(folder, key, parsed.data);
    if (!verdict.classified) unclassified.push(toolName(folder, key));
  }

  const label = server.name.trim().slice(0, LABEL_MAX) || folder;
  const serverText = tomlFile("mcp-server/v1", {
    schema: "mcp-server/v1",
    name: folder,
    label,
    description,
    source: {
      type: "remote",
      url: server.endpointUrl,
      transport: "http",
    },
    auth: auth.auth,
    exposure: { mode: "direct" },
    sync: { schedule: "manual" },
  });
  const toolsText = tomlFile("mcp-tools/v1", {
    schema: "mcp-tools/v1",
    ...(Object.keys(entries).length > 0 ? { tools: entries } : {}),
  });
  const lockText = formatJson({
    schema: "mcp-tools-lock/v1",
    server: folder,
    source: { type: "remote", url: server.endpointUrl },
    tools: locked,
  });

  const serverRead = parseServerToml(serverText);
  if (!serverRead.ok) return { ok: false, reason: firstIssue("server.toml", serverRead.issues), toolsNotMoved };
  const toolsRead = parseToolsToml(toolsText);
  if (!toolsRead.ok) return { ok: false, reason: firstIssue("tools.toml", toolsRead.issues), toolsNotMoved };
  const lockRead = parseLock(lockText);
  if (!lockRead.ok) return { ok: false, reason: firstIssue("tools.lock.json", lockRead.issues), toolsNotMoved };

  return {
    ok: true,
    toolsNotMoved,
    folder: {
      folder,
      serverId: server.id,
      label,
      toolCount: Object.keys(entries).length,
      unclassified,
      files: [
        { path: serverTomlPath(folder), content: serverText },
        { path: toolsTomlPath(folder), content: toolsText },
        { path: toolsLockPath(folder), content: lockText },
      ],
    },
  };
}

// ── The plan ────────────────────────────────────────────────────────────────

type Selection = { kind: "move"; folder: string | null } | { kind: "skip" } | { kind: "list"; reason: string };

function select(server: MigrationServer, existing: ReadonlySet<string> | null): Selection {
  if (server.deletedAt !== null || server.origin !== "legacy") return { kind: "skip" };
  if (!server.enabled) return { kind: "skip" };
  if (server.orgListingId !== null && server.installActive !== true) return { kind: "skip" };
  if (server.steeringName !== null) {
    if (existing !== null && !existing.has(server.steeringName)) {
      return { kind: "move", folder: server.steeringName };
    }
    return { kind: "skip" };
  }
  const reason = unmovableReason(server);
  return reason === null ? { kind: "move", folder: null } : { kind: "list", reason };
}

/** Why a row's transport or endpoint has no server folder form, or null when it has one. */
function unmovableReason(server: MigrationServer): string | null {
  if (!(MOVABLE_TRANSPORTS as readonly string[]).includes(server.transportType)) {
    if (server.transportType === "stdio") {
      return "it runs as a local process (stdio), and a server folder's remote source reaches streamable-http endpoints only.";
    }
    if (server.transportType === "sse") {
      return "its transport is sse, the older HTTP+SSE transport, and a server folder's remote source reaches streamable-http endpoints only (ADR-211).";
    }
    return `its transport is ${server.transportType}, and a server folder's remote source reaches streamable-http endpoints only.`;
  }
  try {
    const url = new URL(server.endpointUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "its endpoint is not an http or https URL.";
    }
  } catch {
    return "its endpoint is not a URL.";
  }
  return null;
}

/** Pack folders in name order into batches of at most `max` files, never splitting one. */
export function batchFolders(
  folders: readonly PlannedFolder[],
  max: number = STEERING_PR_FILES_MAX,
): PlannedFolder[][] {
  const batches: PlannedFolder[][] = [];
  let current: PlannedFolder[] = [];
  let files = 0;
  for (const folder of [...folders].sort((a, b) => a.folder.localeCompare(b.folder))) {
    const n = folder.files.length;
    if (current.length > 0 && files + n > max) {
      batches.push(current);
      current = [];
      files = 0;
    }
    current.push(folder);
    files += n;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** The folders, batches, and lists a migration writes. Reads nothing and writes nothing. */
export function planMigration(input: MigrationInput): MigrationPlan {
  const existing = input.existingFolders ? new Set(input.existingFolders) : null;
  const taken = new Set<string>([BUILTIN_SERVER, ...(input.existingFolders ?? [])]);
  for (const s of input.servers) {
    if (s.deletedAt === null && s.steeringName !== null) taken.add(s.steeringName);
  }

  const folders: PlannedFolder[] = [];
  const notMoved: ServerNotMoved[] = [];
  const toolsNotMoved: ToolNotMoved[] = [];
  const servers = [...input.servers].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  for (const server of servers) {
    const choice = select(server, existing);
    if (choice.kind === "skip") continue;
    if (choice.kind === "list") {
      notMoved.push({ name: server.name, reason: choice.reason });
      continue;
    }
    const folder =
      choice.folder ?? unique(nameFrom(server.name, "server", "s_", FOLDER_MAX), FOLDER_MAX, taken);
    const result = buildFolder(server, folder, input);
    toolsNotMoved.push(...result.toolsNotMoved);
    if (!result.ok) {
      notMoved.push({ name: server.name, reason: result.reason });
      continue;
    }
    taken.add(folder);
    folders.push(result.folder);
  }

  const packed = batchFolders(folders);
  const batches = packed.map((group, i) => ({
    index: i + 1,
    total: packed.length,
    folders: group,
    files: group.flatMap((f) => f.files),
  }));
  return { batches, notMoved, toolsNotMoved };
}

// ── The PR ──────────────────────────────────────────────────────────────────

export function batchTitle(batch: MigrationBatch): string {
  return `Move connected MCP servers into the steering repo (batch ${batch.index} of ${batch.total})`;
}

function branchStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "z").toLowerCase();
}

export function batchBranch(batch: MigrationBatch, now: Date): string {
  return `tools/migrate-servers-${branchStamp(now)}-${batch.index}`;
}

export function batchBody(batch: MigrationBatch, plan: MigrationPlan): string {
  const lines: string[] = [
    `Batch ${batch.index} of ${batch.total}.`,
    "",
    "This PR moves servers this workspace connected before it had a steering repo. Each server becomes a folder under `tools/servers/`. When it merges, the next publish takes over each server's row, so the row keeps its id, its tool snapshots, and its consents.",
    "",
    "Registry changes open steering PRs only after every batch merges. Until then, connecting a server writes its row directly.",
    "",
    "## Servers in this batch",
    "",
    ...batch.folders.map(
      (f) => `- \`${f.folder}\` (${f.label}): ${f.toolCount} ${f.toolCount === 1 ? "tool" : "tools"}`,
    ),
  ];
  const unclassified = batch.folders.flatMap((f) => f.unclassified);
  if (unclassified.length > 0) {
    lines.push(
      "",
      "## Tools with no classification",
      "",
      "These tools had no valid classification. Each is written as risk high, or its declared grade when that is higher, with side effect write and egress third_party. Check each one before you merge.",
      "",
      ...unclassified.map((name) => `- \`${name}\``),
    );
  }
  lines.push(
    "",
    "## Credentials and URLs",
    "",
    "Each folder names its credential as `oxagen:credential/<folder>`. That name is a placeholder. The secret stays on the server's row, and the server keeps using it after the takeover.",
    "",
    "Each server's URL is committed to this repo. A server whose URL has a query string was not moved. Check that no URL in this batch carries a secret in its path before you merge.",
  );
  if (plan.notMoved.length > 0) {
    lines.push(
      "",
      "## Servers not moved",
      "",
      "These servers stay connected the old way.",
      "",
      ...plan.notMoved.map((s) => `- ${s.name}: ${s.reason}`),
    );
  }
  if (plan.toolsNotMoved.length > 0) {
    lines.push(
      "",
      "## Tools not moved",
      "",
      ...plan.toolsNotMoved.map((t) => `- \`${t.server}\`, ${t.tool}: ${t.reason}`),
    );
  }
  const body = lines.join("\n");
  if (body.length <= BODY_MAX) return `${body}\n`;
  return `${body.slice(0, BODY_MAX)}\n\nThe list is cut at ${BODY_MAX} characters.\n`;
}

// ── Opening the batches ─────────────────────────────────────────────────────

export interface OpenBatchesArgs {
  scope: WorkspaceScope;
  plan: MigrationPlan;
  opener: SteeringPrOpener;
  actorUserId: string | null;
  now: Date;
  /** Names each moved row's folder once its batch's PR is open. */
  markMoved: (folders: readonly PlannedFolder[]) => Promise<void>;
}

/** Open each batch as a steering PR, in order, and mark its rows after it opens. */
export async function openBatches(args: OpenBatchesArgs): Promise<OpenedSteeringPr[]> {
  const opened: OpenedSteeringPr[] = [];
  for (const batch of args.plan.batches) {
    const pr = await args.opener.open({
      orgId: args.scope.orgId,
      workspaceId: args.scope.workspaceId,
      actorUserId: args.actorUserId,
      branch: batchBranch(batch, args.now),
      title: batchTitle(batch),
      body: batchBody(batch, args.plan),
      files: batch.files,
    });
    try {
      await args.markMoved(batch.folders);
    } catch (error) {
      throw new Error(
        `Steering PR #${pr.number} is open, but its servers could not be marked as moved. Set steering_name on each server it lists before it merges, or close it. ${(error as Error).message}`,
      );
    }
    opened.push(pr);
  }
  return opened;
}

// ── migrate() ───────────────────────────────────────────────────────────────

export interface MigrateOptions {
  /** Defaults to the registered opener. */
  opener?: SteeringPrOpener;
  existingFolders?: readonly string[];
  actorUserId?: string | null;
  now?: Date;
}

export interface MigrateResult {
  opened: OpenedSteeringPr[];
  plan: MigrationPlan;
}

/** Live rows in the workspace, or the one row `serverId` names. */
async function loadServers(scope: WorkspaceScope, serverId?: string): Promise<MigrationServer[]> {
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.mcpServers.id,
        name: schema.mcpServers.name,
        transportType: schema.mcpServers.transportType,
        endpointUrl: schema.mcpServers.endpointUrl,
        authStrategy: schema.mcpServers.authStrategy,
        authConfig: schema.mcpServers.authConfig,
        orgListingId: schema.mcpServers.orgListingId,
        enabled: schema.mcpServers.enabled,
        origin: schema.mcpServers.origin,
        steeringName: schema.mcpServers.steeringName,
        deletedAt: schema.mcpServers.deletedAt,
        authKind: schema.pluginInstalledPlugins.authKind,
        installEnabled: schema.pluginInstalledPlugins.enabled,
        installDeletedAt: schema.pluginInstalledPlugins.deletedAt,
      })
      .from(schema.mcpServers)
      .leftJoin(
        schema.pluginInstalledPlugins,
        eq(schema.mcpServers.orgListingId, schema.pluginInstalledPlugins.id),
      )
      .where(
        and(
          eq(schema.mcpServers.orgId, scope.orgId),
          eq(schema.mcpServers.workspaceId, scope.workspaceId),
          isNull(schema.mcpServers.deletedAt),
          ...(serverId === undefined ? [] : [eq(schema.mcpServers.id, serverId)]),
        ),
      ),
  );

  const servers: MigrationServer[] = [];
  for (const row of rows) {
    let headerNames: string[] | null = null;
    if (row.orgListingId === null && row.authStrategy === "header" && row.origin !== "steering") {
      // Only the header names are read. The values stay on the row.
      try {
        headerNames = Object.keys(await decryptMcpAuthConfig(row.authConfig));
      } catch (error) {
        logger.warn(
          { serverId: row.id, err: (error as Error).message },
          "mcp-studio: could not read a header server's auth header name",
        );
      }
    }
    servers.push({
      id: row.id,
      name: row.name,
      transportType: row.transportType,
      endpointUrl: row.endpointUrl,
      authStrategy: row.authStrategy,
      authKind: row.orgListingId === null ? null : row.authKind,
      orgListingId: row.orgListingId,
      installActive:
        row.orgListingId === null ? null : row.installEnabled === true && row.installDeletedAt === null,
      headerNames: headerNames !== null && headerNames.length > 0 ? headerNames : null,
      enabled: row.enabled,
      origin: row.origin,
      steeringName: row.steeringName,
      deletedAt: row.deletedAt,
    });
  }
  return servers;
}

/** The live MCP tool rows of the given servers, each with its active version. */
async function loadTools(scope: WorkspaceScope, serverIds: readonly string[]): Promise<MigrationTool[]> {
  if (serverIds.length === 0) return [];
  const toolRows = await withTenantDb((tx) =>
    tx
      .select({
        serverId: schema.tools.mcpServerId,
        name: schema.tools.name,
        description: schema.tools.description,
        enabled: schema.tools.enabled,
        versionId: schema.toolVersions.id,
        inputSchema: schema.toolVersions.inputSchema,
        riskGrade: schema.toolVersions.riskGrade,
        impacts: schema.toolVersions.impacts,
        classification: schema.toolVersions.classification,
        classifiedRiskGrade: schema.toolVersions.classifiedRiskGrade,
      })
      .from(schema.tools)
      .leftJoin(schema.toolVersions, eq(schema.toolVersions.id, schema.tools.activeVersionId))
      .where(
        and(
          eq(schema.tools.orgId, scope.orgId),
          eq(schema.tools.workspaceId, scope.workspaceId),
          eq(schema.tools.source, "mcp"),
          isNull(schema.tools.deletedAt),
          inArray(schema.tools.mcpServerId, [...serverIds]),
        ),
      ),
  );
  return toolRows.flatMap((t) =>
    t.serverId === null
      ? []
      : [
          {
            serverId: t.serverId,
            name: t.name,
            description: t.description,
            enabled: t.enabled,
            version:
              t.versionId === null
                ? null
                : {
                    inputSchema: t.inputSchema,
                    riskGrade: t.riskGrade ?? "",
                    impacts: t.impacts ?? null,
                    classification: t.classification,
                    classifiedRiskGrade: t.classifiedRiskGrade ?? null,
                  },
          },
        ],
  );
}

async function loadDescriptors(
  scope: WorkspaceScope,
  serverIds: readonly string[],
): Promise<MigrationDescriptor[]> {
  const descriptors: MigrationDescriptor[] = [];
  for (const serverId of serverIds) {
    for (const d of await readLatestPinnedDescriptors(scope.orgId, scope.workspaceId, serverId)) {
      descriptors.push({ serverId, name: d.name, description: d.description, inputSchema: d.inputSchema });
    }
  }
  return descriptors;
}

async function loadInput(
  scope: WorkspaceScope,
  existingFolders: readonly string[] | undefined,
): Promise<MigrationInput> {
  const servers = await loadServers(scope);
  const candidates = servers.filter((s) => s.origin === "legacy" && s.enabled).map((s) => s.id);
  if (candidates.length === 0) return { servers, tools: [], descriptors: [], existingFolders };
  return {
    servers,
    tools: await loadTools(scope, candidates),
    descriptors: await loadDescriptors(scope, candidates),
    existingFolders,
  };
}

async function markMoved(scope: WorkspaceScope, folders: readonly PlannedFolder[]): Promise<void> {
  await withTenantDb(async (tx) => {
    for (const f of folders) {
      await tx
        .update(schema.mcpServers)
        .set({ steeringName: f.folder, updatedAt: new Date() })
        .where(
          and(
            eq(schema.mcpServers.id, f.serverId),
            eq(schema.mcpServers.workspaceId, scope.workspaceId),
            eq(schema.mcpServers.origin, "legacy"),
            isNull(schema.mcpServers.deletedAt),
          ),
        );
    }
  });
}

/**
 * Move a workspace's connected MCP servers into its steering repo. Opens one
 * steering PR per batch and returns them with the plan. A workspace with
 * nothing to move opens none.
 */
export async function migrate(
  scope: WorkspaceScope,
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  const opener = options.opener ?? steeringPrOpener();
  if (opener === null) {
    throw new SteeringPrUnavailableError(
      "No steering PR opener is registered, so the servers cannot be moved yet.",
    );
  }
  if (!(await opener.hasSteeringRepo(scope))) {
    throw new SteeringPrUnavailableError(
      "This workspace has no steering repo. Create one before moving its servers.",
    );
  }
  const now = options.now ?? new Date();
  return runInTenantScope(
    {
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      principalKind: "service",
      capabilityName: MIGRATE_CAPABILITY,
    },
    async () => {
      const input = await loadInput(scope, options.existingFolders);
      const plan = planMigration(input);
      const opened = await openBatches({
        scope,
        plan,
        opener,
        actorUserId: options.actorUserId ?? null,
        now,
        markMoved: (folders) => markMoved(scope, folders),
      });
      logger.info(
        {
          workspaceId: scope.workspaceId,
          batches: plan.batches.length,
          moved: plan.batches.reduce((n, b) => n + b.folders.length, 0),
          notMoved: plan.notMoved.length,
          toolsNotMoved: plan.toolsNotMoved.length,
        },
        "mcp-studio: opened migration batches",
      );
      return { opened, plan };
    },
  );
}

// ── The direct paths' writer ────────────────────────────────────────────────

/** A folder name for a server, unique against `taken` and never builtin. */
export function folderNameFor(serverName: string, taken: ReadonlySet<string>): string {
  return unique(
    nameFrom(serverName, "server", "s_", FOLDER_MAX),
    FOLDER_MAX,
    new Set([BUILTIN_SERVER, ...taken]),
  );
}

export type AddServerPlan =
  | { ok: true; folder: PlannedFolder; toolsNotMoved: ToolNotMoved[] }
  | { ok: false; reason: string };

/** The folder a proposed row becomes. Reads nothing and writes nothing. */
export function planAddServer(
  server: MigrationServer,
  folder: string,
  input: Pick<MigrationInput, "tools" | "descriptors">,
): AddServerPlan {
  const reason = unmovableReason(server);
  if (reason !== null) return { ok: false, reason };
  const result = buildFolder(server, folder, input, ADDED_DESCRIPTION);
  return result.ok
    ? { ok: true, folder: result.folder, toolsNotMoved: result.toolsNotMoved }
    : { ok: false, reason: result.reason };
}

function credentialsSection(folders: readonly PlannedFolder[]): string[] {
  const refs = folders.map((f) => `\`${credentialFor(f.folder)}\``).join(", ");
  return [
    "## Credentials and URLs",
    "",
    `The credential ${refs} is a placeholder. The secret stays on the server's row in Oxagen.`,
    "",
    "The server's URL is committed to this repo. Check that its path carries no secret before you merge.",
  ];
}

export function addServerBody(folder: PlannedFolder, toolsNotMoved: readonly ToolNotMoved[]): string {
  const lines: string[] = [
    `This PR adds the MCP server ${folder.label} as \`tools/servers/${folder.folder}/\`, with ${folder.toolCount} ${folder.toolCount === 1 ? "tool" : "tools"}. It was connected in Oxagen, and this workspace's tools live in this repo, so Oxagen opened this PR in place of connecting it.`,
    "",
    "When this PR merges, the next publish connects the server. Until then it stays off. If you close this PR, the server is never connected.",
  ];
  if (folder.unclassified.length > 0) {
    lines.push(
      "",
      "## Tools with no classification",
      "",
      "These tools have no classification yet. Each is written as risk high, side effect write, and egress third_party. Check each one before you merge.",
      "",
      ...folder.unclassified.map((name) => `- \`${name}\``),
    );
  }
  lines.push("", ...credentialsSection([folder]));
  if (toolsNotMoved.length > 0) {
    lines.push(
      "",
      "## Tools left out",
      "",
      ...toolsNotMoved.map((t) => `- ${t.tool}: ${t.reason}`),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** A pinned tools/list entry, as mcp.tool_snapshots holds it. */
export interface PinnedTool {
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
}

export interface AddToolsInput {
  folder: string;
  /** tools.toml and tools.lock.json on the steering repo's default branch. */
  toolsText: string;
  lockText: string;
  pins: readonly PinnedTool[];
  toolNames: readonly string[];
}

export type AddToolsPlan =
  | {
      ok: true;
      files: SteeringPrFile[];
      /** Full names of the tools the PR adds. */
      added: string[];
      /** Upstream names tools.toml already lists. */
      alreadyListed: string[];
      toolsNotMoved: ToolNotMoved[];
    }
  | { ok: false; code: "not_found" | "conflict"; reason: string; message: string };

/**
 * The tools.toml and lock a steering server has once `toolNames` are added.
 * Existing entries and the text around them stay as they are: each new tool is
 * appended as its own table, unclassified. Reads nothing and writes nothing.
 */
export function planAddTools(input: AddToolsInput): AddToolsPlan {
  const { folder } = input;
  const toolsRead = parseToolsToml(input.toolsText);
  if (!toolsRead.ok) {
    return {
      ok: false,
      code: "conflict",
      reason: "tools_toml_invalid",
      message: `tools/servers/${folder}/tools.toml on the default branch does not validate. Fix it before you add tools. ${firstIssue("tools.toml", toolsRead.issues)}`,
    };
  }
  const lockRead = parseLock(input.lockText);
  if (!lockRead.ok) {
    return {
      ok: false,
      code: "conflict",
      reason: "tools_lock_invalid",
      message: `tools/servers/${folder}/tools.lock.json on the default branch does not validate. Fix it before you add tools. ${firstIssue("tools.lock.json", lockRead.issues)}`,
    };
  }

  const existing = toolsRead.value.tools ?? {};
  const listed = new Set(Object.entries(existing).map(([key, entry]) => entry.upstream ?? key));
  const keys = new Set([...Object.keys(existing), ...Object.keys(lockRead.value.tools)]);
  const pins = new Map(input.pins.map((p) => [p.name, p] as const));
  const keyMax = Math.min(TOOL_KEY_LIMIT, TOOL_NAME_MAX - TOOL_SEPARATOR.length - folder.length);

  const entries: Record<string, ToolsEntry> = {};
  const locked: Record<string, unknown> = {};
  const added: string[] = [];
  const alreadyListed: string[] = [];
  const toolsNotMoved: ToolNotMoved[] = [];
  for (const name of [...new Set(input.toolNames)].sort()) {
    const pin = pins.get(name);
    if (!pin) {
      return {
        ok: false,
        code: "not_found",
        reason: "tool_not_pinned",
        message: `The server has no pinned tool named ${name}.`,
      };
    }
    if (listed.has(name)) {
      alreadyListed.push(name);
      continue;
    }
    if (name.length > UPSTREAM_NAME_MAX) {
      toolsNotMoved.push({ server: folder, tool: name.slice(0, 64), reason: `its name is over ${UPSTREAM_NAME_MAX} characters.` });
      continue;
    }
    const parsed = mcpToolSchema.safeParse({
      name,
      ...(pin.description ? { description: pin.description } : {}),
      inputSchema: pin.inputSchema,
    });
    if (!parsed.success) {
      toolsNotMoved.push({ server: folder, tool: name, reason: "its input schema is not a JSON Schema object." });
      continue;
    }
    const key = unique(nameFrom(name, "tool", "t_", keyMax), keyMax, keys);
    keys.add(key);
    entries[key] = { ...(key === name ? {} : { upstream: name }), ...UNCLASSIFIED };
    locked[key] = lockEntry(folder, key, parsed.data);
    added.push(toolName(folder, key));
  }
  if (added.length === 0) {
    const why = [
      ...alreadyListed.map((n) => `${n} is already listed.`),
      ...toolsNotMoved.map((t) => `${t.tool}: ${t.reason}`),
    ];
    return {
      ok: false,
      code: "conflict",
      reason: "nothing_to_add",
      message: `No tool can be added to tools/servers/${folder}/tools.toml. ${why.join(" ")}`.trim(),
    };
  }

  // Append each new table, so the file's comments and order stay as they are.
  // A file whose text cannot take an appended table is written again whole.
  const base = input.toolsText.endsWith("\n") ? input.toolsText : `${input.toolsText}\n`;
  let toolsText = `${base}\n${stringify({ tools: entries })}`;
  if (!parseToolsToml(toolsText).ok) {
    toolsText = tomlFile("mcp-tools/v1", {
      ...toolsRead.value,
      tools: { ...existing, ...entries },
    });
  }
  const toolsCheck = parseToolsToml(toolsText);
  if (!toolsCheck.ok) {
    return {
      ok: false,
      code: "conflict",
      reason: "tools_toml_invalid",
      message: `The new tools.toml does not validate. ${firstIssue("tools.toml", toolsCheck.issues)}`,
    };
  }
  const lockText = formatJson({
    ...lockRead.value,
    tools: { ...lockRead.value.tools, ...locked },
  });
  const lockCheck = parseLock(lockText);
  if (!lockCheck.ok) {
    return {
      ok: false,
      code: "conflict",
      reason: "tools_lock_invalid",
      message: `The new tools.lock.json does not validate. ${firstIssue("tools.lock.json", lockCheck.issues)}`,
    };
  }
  return {
    ok: true,
    added,
    alreadyListed,
    toolsNotMoved,
    files: [
      { path: toolsTomlPath(folder), content: toolsText },
      { path: toolsLockPath(folder), content: lockText },
    ],
  };
}

export function addToolsBody(folder: string, plan: Extract<AddToolsPlan, { ok: true }>): string {
  const lines: string[] = [
    `This PR adds ${plan.added.length} ${plan.added.length === 1 ? "tool" : "tools"} to \`tools/servers/${folder}/\`. When it merges, the next publish adds them to the registry.`,
    "",
    "## Tools with no classification",
    "",
    "Each tool is written as risk high, side effect write, and egress third_party. Check each one before you merge.",
    "",
    ...plan.added.map((name) => `- \`${name}\``),
  ];
  if (plan.alreadyListed.length > 0) {
    lines.push("", "## Tools already listed", "", ...plan.alreadyListed.map((n) => `- ${n}`));
  }
  if (plan.toolsNotMoved.length > 0) {
    lines.push("", "## Tools left out", "", ...plan.toolsNotMoved.map((t) => `- ${t.tool}: ${t.reason}`));
  }
  return `${lines.join("\n")}\n`;
}

/** The reads and writes the writer makes; injectable for tests. */
export interface ServerFolderWriterDeps {
  opener(): SteeringPrOpener | null;
  loadServer(scope: WorkspaceScope, serverId: string): Promise<MigrationServer | null>;
  loadTools(scope: WorkspaceScope, serverIds: readonly string[]): Promise<MigrationTool[]>;
  loadDescriptors(scope: WorkspaceScope, serverIds: readonly string[]): Promise<MigrationDescriptor[]>;
  /** The steering_name of every live row in the workspace. */
  takenFolders(scope: WorkspaceScope): Promise<string[]>;
  /**
   * Reserve a folder: set steering_name on a proposed row that has none.
   * False when no row matched. Throws a unique violation on
   * mcp_servers_ws_steering_name_uniq when another live row holds the name.
   */
  nameFolder(scope: WorkspaceScope, serverId: string, folder: string): Promise<boolean>;
  /** Release a reservation nameFolder made, when the steering PR did not open. */
  unnameFolder(scope: WorkspaceScope, serverId: string, folder: string): Promise<void>;
  now(): Date;
}

const postgresWriterDeps: ServerFolderWriterDeps = {
  opener: steeringPrOpener,
  loadServer: async (scope, serverId) => (await loadServers(scope, serverId))[0] ?? null,
  loadTools,
  loadDescriptors,
  takenFolders: async (scope) => {
    const rows = await withTenantDb((tx) =>
      tx
        .select({ steeringName: schema.mcpServers.steeringName })
        .from(schema.mcpServers)
        .where(
          and(
            eq(schema.mcpServers.orgId, scope.orgId),
            eq(schema.mcpServers.workspaceId, scope.workspaceId),
            isNull(schema.mcpServers.deletedAt),
            isNotNull(schema.mcpServers.steeringName),
          ),
        ),
    );
    return rows.flatMap((r) => (r.steeringName === null ? [] : [r.steeringName]));
  },
  nameFolder: async (scope, serverId, folder) => {
    const rows = await withTenantDb((tx) =>
      tx
        .update(schema.mcpServers)
        .set({ steeringName: folder, updatedAt: new Date() })
        .where(
          and(
            eq(schema.mcpServers.id, serverId),
            eq(schema.mcpServers.workspaceId, scope.workspaceId),
            eq(schema.mcpServers.origin, "proposed"),
            isNull(schema.mcpServers.steeringName),
            isNull(schema.mcpServers.deletedAt),
          ),
        )
        .returning({ id: schema.mcpServers.id }),
    );
    return rows.length > 0;
  },
  unnameFolder: async (scope, serverId, folder) => {
    await withTenantDb((tx) =>
      tx
        .update(schema.mcpServers)
        .set({ steeringName: null, updatedAt: new Date() })
        .where(
          and(
            eq(schema.mcpServers.id, serverId),
            eq(schema.mcpServers.workspaceId, scope.workspaceId),
            eq(schema.mcpServers.origin, "proposed"),
            eq(schema.mcpServers.steeringName, folder),
          ),
        ),
    );
  },
  now: () => new Date(),
};

/** How many taken folder names addServer skips past before it gives up. */
const FOLDER_PROBES_MAX = 20;

/** The unique index that holds one live row per folder in a workspace. */
const STEERING_NAME_INDEX = "mcp_servers_ws_steering_name_uniq";

function refuse(reason: string, message: string): HandlerError {
  return new HandlerError({ code: "conflict", reason, message });
}

/**
 * The ServerFolderWriter the direct paths open steering PRs through. Boot
 * registers it with registerServerFolderWriter. It runs in the caller's tenant
 * scope.
 */
export function createServerFolderWriter(
  overrides: Partial<ServerFolderWriterDeps> = {},
): ServerFolderWriter {
  const deps: ServerFolderWriterDeps = { ...postgresWriterDeps, ...overrides };
  const openerOrThrow = (): SteeringPrOpener => {
    const opener = deps.opener();
    if (opener === null) {
      throw new SteeringPrUnavailableError("No steering PR opener is registered.");
    }
    return opener;
  };

  return {
    async addServer(request: AddServerRequest): Promise<OpenedSteeringPr> {
      const scope = { orgId: request.orgId, workspaceId: request.workspaceId };
      const opener = openerOrThrow();
      const server = await deps.loadServer(scope, request.serverId);
      if (server === null || server.origin !== "proposed" || server.steeringName !== null) {
        throw refuse(
          "server_not_proposed",
          "Only a proposed server with no folder can be added through a steering PR.",
        );
      }

      // The folder is reserved on the row before the PR opens. The unique
      // index on (workspace, steering_name) then settles a race between two
      // adds of the same name, and no PR is ever open without its row.
      // A name another live row holds, or one already on the default branch
      // (a merged PR the next publish has not taken in yet), is taken.
      const ids = [server.id];
      const input = {
        tools: await deps.loadTools(scope, ids),
        descriptors: await deps.loadDescriptors(scope, ids),
      };
      const taken = new Set(await deps.takenFolders(scope));
      const reserve = async (): Promise<{ folder: string; plan: Extract<AddServerPlan, { ok: true }> }> => {
        for (let probe = 0; probe <= FOLDER_PROBES_MAX; probe += 1) {
          const folder = folderNameFor(server.name, taken);
          taken.add(folder);
          if ((await opener.readFile(scope, serverTomlPath(folder))) !== null) continue;
          const plan = planAddServer(server, folder, input);
          if (!plan.ok) {
            throw refuse(
              "server_not_movable",
              `${server.name} cannot live in a server folder: ${plan.reason}`,
            );
          }
          let named: boolean;
          try {
            named = await deps.nameFolder(scope, server.id, folder);
          } catch (error) {
            if (isUniqueViolation(error, STEERING_NAME_INDEX)) continue;
            throw error;
          }
          if (!named) {
            throw refuse(
              "server_not_proposed",
              "The server changed while its folder was being written. It is no longer a proposed server with no folder.",
            );
          }
          return { folder, plan };
        }
        throw refuse("folder_name_taken", `Every folder name tried for ${server.name} is taken.`);
      };

      const { folder, plan } = await reserve();
      let pr: OpenedSteeringPr;
      try {
        pr = await opener.open({
          ...scope,
          actorUserId: request.actorUserId,
          branch: `tools/add-server-${folder.replace(/_/g, "-")}-${branchStamp(deps.now())}`,
          title: `Add the ${plan.folder.label} MCP server`,
          body: addServerBody(plan.folder, plan.toolsNotMoved),
          files: plan.folder.files,
        });
      } catch (error) {
        await deps.unnameFolder(scope, server.id, folder).catch((releaseError: unknown) => {
          logger.error(
            { workspaceId: scope.workspaceId, serverId: server.id, folder, err: (releaseError as Error).message },
            "mcp-studio: the steering PR did not open and the folder name was not released; clear the row's steering_name",
          );
        });
        throw error;
      }
      logger.info(
        { workspaceId: scope.workspaceId, serverId: server.id, folder, pr: pr.number },
        "mcp-studio: opened a steering PR that adds a server",
      );
      return pr;
    },

    async addTools(request: AddToolsRequest): Promise<OpenedSteeringPr> {
      const scope = { orgId: request.orgId, workspaceId: request.workspaceId };
      const opener = openerOrThrow();
      const server = await deps.loadServer(scope, request.serverId);
      if (server === null || server.origin !== "steering" || server.steeringName === null) {
        throw refuse(
          "server_not_steering",
          "Tools are added through a steering PR only to a server its steering repo holds.",
        );
      }
      const folder = server.steeringName;
      const [toolsText, lockText] = await Promise.all([
        opener.readFile(scope, toolsTomlPath(folder)),
        opener.readFile(scope, toolsLockPath(folder)),
      ]);
      if (toolsText === null || lockText === null) {
        throw refuse(
          "folder_missing",
          `tools/servers/${folder}/ has no ${toolsText === null ? "tools.toml" : "tools.lock.json"} on the default branch.`,
        );
      }
      const pins = await deps.loadDescriptors(scope, [server.id]);
      const plan = planAddTools({ folder, toolsText, lockText, pins, toolNames: request.toolNames });
      if (!plan.ok) {
        throw new HandlerError({ code: plan.code, reason: plan.reason, message: plan.message });
      }
      const pr = await opener.open({
        ...scope,
        actorUserId: request.actorUserId,
        branch: `tools/add-tools-${folder.replace(/_/g, "-")}-${branchStamp(deps.now())}`,
        title: `Add ${plan.added.length} ${plan.added.length === 1 ? "tool" : "tools"} to the ${folder} MCP server`,
        body: addToolsBody(folder, plan),
        files: plan.files,
      });
      logger.info(
        { workspaceId: scope.workspaceId, serverId: server.id, folder, pr: pr.number, added: plan.added.length },
        "mcp-studio: opened a steering PR that adds tools",
      );
      return pr;
    },
  };
}
