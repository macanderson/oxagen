// project.ts: write a published steering version's tools into the registry.
//
// A steering version's tool manifest names every server folder and every tool
// the gateway serves. project() makes mcp.mcp_servers, agent.tools and
// agent.tool_versions agree with it, in one transaction that holds the
// workspace rule lock:
//
// - A server folder is one mcp.mcp_servers row with origin steering, found by
//   steering_name. A legacy row that a migration PR named is taken over and
//   keeps its id, so the consents and tool snapshots keyed on that id survive.
//   So is a proposed row, which a direct path wrote disabled while it opened a
//   steering PR that adds the server. The takeover turns a proposed row on
//   and keeps a legacy row's enabled flag.
// - A tool is one agent.tools row whose slug is its full name,
//   <server>__<tool>. A definition_hash the tool has never carried publishes a
//   version through publishToolIn and makes it active. A hash that one of its
//   versions already carries makes that version active again, which is how a
//   restore rolls a tool back.
// - The classification tools.toml states is written to the version. A change
//   on a version that already exists edits it in place, and the trigger on
//   agent.tool_versions bumps the deny generation.
// - A tool its folder no longer lists is disabled. A folder the version no
//   longer holds soft-deletes its server and disables that server's tools.
//
// Projecting the same version twice writes nothing the second time.
//
// This file stays out of the handlers barrel: the mcp-studio barrel loads
// grpc-js. Callers import it as @oxagen/handlers/mcp-studio/project.

import { schema, withSystemDb, withTenantDb, type Tx } from "@oxagen/database";
import {
  toCodeClassification,
  toolManifestSchema,
  type ManifestServer,
  type ManifestTool,
  type ToolManifest,
  type ToolsClassification,
} from "@oxagen/mcp-studio";
import type { Bundle } from "@oxagen/oxagen/steering-repo/bundle";
import type {
  ToolClassification,
  ToolRiskGrade,
} from "@oxagen/oxagen/contracts/tool.classification";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, inArray, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import { lockWorkspaceRuleSet } from "../_approval_rule";
import {
  invalidateApprovalRules,
  type ApprovalToolFacts,
} from "../lib/approval-rule-invalidation";
import { publishToolIn } from "../lib/tool-registry";
import { canonicalJson } from "../registry-digest";
import { logger } from "../logger";

/** The capability a steering publish writes the registry under. */
export const PROJECT_CAPABILITY = "publish_steering_version";

export interface ProjectOptions {
  /**
   * The server folders under tools/servers/ at the version's commit. A folder
   * listed here that the manifest leaves out failed to compile, so its rows
   * are left as they are. Without it, every steering server the manifest
   * leaves out is retired.
   */
  folders?: readonly string[];
  /** The clock for the rows project() stamps. Defaults to the current time. */
  now?: Date;
}

export interface ProjectionSummary {
  servers: {
    inserted: number;
    updated: number;
    revived: number;
    takenOver: number;
    retired: number;
  };
  tools: {
    published: number;
    activated: number;
    reclassified: number;
    refreshed: number;
    disabled: number;
    enabled: number;
  };
}

/** A tool the steering version names under a slug a non-MCP tool already holds. */
export class ProjectionConflictError extends Error {
  readonly code = "steering_tool_conflict";
  constructor(
    readonly slug: string,
    readonly source: string,
  ) {
    super(
      `The steering version names the tool ${slug}, but a ${source} tool already has that name in this workspace. Rename the tool in its server folder.`,
    );
    this.name = "ProjectionConflictError";
  }
}

// ── The registry rows project() reads ───────────────────────────────────────

export interface SnapshotServer {
  id: string;
  name: string;
  steeringName: string;
  origin: string;
  transportType: string;
  endpointUrl: string;
  discoveredTools: unknown;
  enabled: boolean;
  deletedAt: Date | null;
}

export interface SnapshotTool {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  source: string;
  enabled: boolean;
  mcpServerId: string | null;
  activeVersionId: string | null;
  deletedAt: Date | null;
}

export interface SnapshotVersion {
  id: string;
  toolId: string;
  versionNumber: number;
  checksum: string;
  riskGrade: string;
  readOnly: boolean;
  impacts: readonly string[] | null;
  measures: unknown;
  manifest: unknown;
  classification: unknown;
  classifiedRiskGrade: string | null;
}

export interface RegistrySnapshot {
  servers: readonly SnapshotServer[];
  tools: readonly SnapshotTool[];
  versions: readonly SnapshotVersion[];
}

// ── The plan ─────────────────────────────────────────────────────────────────

type TransportType =
  | "streamable-http"
  | "sse"
  | "stdio"
  | "openapi"
  | "graphql"
  | "grpc";
type AuthStrategy = "none" | "bearer" | "header";

/** The mcp.mcp_servers columns a server folder sets. */
export interface ServerColumns {
  name: string;
  transportType: TransportType;
  endpointUrl: string;
  /** Written on insert only. A takeover keeps the legacy row's auth. */
  authStrategy: AuthStrategy;
  /** The upstream names of the folder's tools, sorted. */
  discoveredTools: string[];
}

export interface ServerStep {
  /** The folder name, which is steering_name. */
  name: string;
  action: "insert" | "update" | "keep" | "revive" | "takeover";
  /** The row's id, or null for an insert. */
  id: string | null;
  columns: ServerColumns;
  /** Set the row's enabled flag to true: on an insert, a revive, and a takeover of a proposed row. */
  enable: boolean;
}

/** The classification half of a version, as tools.toml states it. */
export interface VersionFacts {
  risk: ToolRiskGrade;
  classification: ToolClassification;
  impacts: string[];
  readOnly: boolean;
}

interface ToolStepBase {
  server: string;
  /** The full name, <server>__<tool>, which is the slug. */
  fullName: string;
  entry: ManifestTool;
  facts: VersionFacts;
  /** The existing row, or null when publishToolIn inserts one. */
  tool: SnapshotTool | null;
  /** Clear deleted_at before anything else touches the row. */
  revive: boolean;
  /** Rename a legacy slug to the full name before publishToolIn looks it up. */
  renameFrom: string | null;
  /** Set enabled, per the rule in planProjection. */
  enable: boolean;
}

export type ToolStep =
  | (ToolStepBase & { kind: "publish" })
  | (ToolStepBase & {
      kind: "align";
      tool: SnapshotTool;
      /** The version whose checksum is the definition_hash. */
      version: SnapshotVersion;
      /** The version active before, when activating a different one. */
      previousActive: SnapshotVersion | null;
      activate: boolean;
      reclassify: boolean;
      refreshManifest: boolean;
    });

export interface ProjectionPlan {
  servers: ServerStep[];
  tools: ToolStep[];
  /** Tools to disable: their folder no longer lists them, or their server retired. */
  disable: { id: string; slug: string }[];
  /** Steering servers to soft-delete: their folder is gone. */
  retire: { id: string; name: string }[];
}

const SHA256_PREFIX = "sha256:";

/** The name a tool has on its upstream server, which discoveredTools lists. */
export function upstreamName(key: string, entry: ManifestTool): string {
  const request = entry.request as { kind?: unknown; tool?: unknown };
  return request.kind === "mcp" && typeof request.tool === "string"
    ? request.tool
    : key;
}

/** The environment agents' calls go to: the sandbox, then default, then the first. */
function primaryUrl(server: ManifestServer): string | undefined {
  const environments = Object.entries(server.environments).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const sandbox = environments.find(([, env]) => env.sandbox === true);
  const chosen =
    sandbox?.[1] ?? server.environments.default ?? environments[0]?.[1];
  return chosen?.url;
}

export function serverColumns(server: ManifestServer): ServerColumns {
  const source = server.source;
  let transportType: TransportType;
  let fallback: string;
  switch (source.type) {
    case "remote":
      // server.toml's http is streamable HTTP, the only transport review
      // accepts for a remote server (ADR-211).
      transportType = "streamable-http";
      fallback = source.url;
      break;
    case "registry":
      // With machines, a local gateway runs the entry's package. Without
      // them, the cloud gateway connects to the entry's remote.
      transportType =
        source.machines && source.machines.length > 0
          ? "stdio"
          : "streamable-http";
      fallback = source.server;
      break;
    case "local":
      transportType = "stdio";
      fallback = source.command;
      break;
    default:
      transportType = source.type;
      fallback = source.url ?? server.name;
      break;
  }
  const scheme = server.auth?.scheme.toLowerCase();
  const authStrategy: AuthStrategy =
    scheme === undefined
      ? "none"
      : scheme === "header" || scheme === "basic"
        ? "header"
        : "bearer";
  return {
    name: server.label,
    transportType,
    endpointUrl: primaryUrl(server) ?? fallback,
    authStrategy,
    discoveredTools: Object.entries(server.tools)
      .map(([key, entry]) => upstreamName(key, entry))
      .sort(),
  };
}

/** The upstream names a server row's discovered_tools lists. */
export function discoveredNames(value: unknown): Set<string> {
  const names = new Set<string>();
  if (!Array.isArray(value)) return names;
  for (const item of value) {
    if (typeof item === "string") names.add(item);
    else if (
      item !== null &&
      typeof item === "object" &&
      typeof (item as { name?: unknown }).name === "string"
    )
      names.add((item as { name: string }).name);
  }
  return names;
}

export function versionFacts(entry: ManifestTool): VersionFacts {
  const { risk, classification } = toCodeClassification(
    entry.classification as ToolsClassification,
  );
  return {
    risk,
    classification,
    impacts: [...classification.impacts],
    readOnly: classification.sideEffect === "read",
  };
}

function sortedJson(values: readonly string[] | null): string {
  return canonicalJson([...(values ?? [])].sort());
}

function classificationDiffers(
  version: SnapshotVersion,
  facts: VersionFacts,
): boolean {
  return (
    version.classifiedRiskGrade !== facts.risk ||
    version.riskGrade !== facts.risk ||
    version.readOnly !== facts.readOnly ||
    canonicalJson(version.classification ?? null) !==
      canonicalJson(facts.classification) ||
    sortedJson(version.impacts) !== sortedJson(facts.impacts)
  );
}

function sameColumns(row: SnapshotServer, columns: ServerColumns): boolean {
  return (
    row.name === columns.name &&
    row.transportType === columns.transportType &&
    row.endpointUrl === columns.endpointUrl &&
    canonicalJson(row.discoveredTools ?? null) ===
      canonicalJson(columns.discoveredTools)
  );
}

function sameSlug(a: string, b: string): boolean {
  // agent.tools.slug is citext.
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Decide every write project() makes, from the manifest and the rows it read.
 *
 * A tool is enabled when it is new, when its row or its server's row comes
 * back from a soft delete, or when its folder lists it again after a version
 * that did not. A tool someone disabled while its folder kept listing it stays
 * disabled, and a takeover keeps each legacy tool's enabled flag.
 */
export function planProjection(
  manifest: ToolManifest,
  snapshot: RegistrySnapshot,
  options: { folders?: readonly string[] } = {},
): ProjectionPlan {
  const plan: ProjectionPlan = {
    servers: [],
    tools: [],
    disable: [],
    retire: [],
  };
  const claimed = new Set<string>();
  const manifestNames = new Set(manifest.servers.map((s) => s.name));
  const kept = new Set(options.folders ?? []);
  const disabled = new Set<string>();

  for (const server of [...manifest.servers].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const columns = serverColumns(server);
    const live = snapshot.servers.find(
      (row) => row.steeringName === server.name && row.deletedAt === null,
    );
    const dead = live
      ? undefined
      : snapshot.servers
          .filter(
            (row) => row.steeringName === server.name && row.deletedAt !== null,
          )
          .sort(
            (a, b) =>
              (b.deletedAt?.getTime() ?? 0) - (a.deletedAt?.getTime() ?? 0),
          )[0];
    const row = live ?? dead ?? null;
    const action: ServerStep["action"] = live
      ? live.origin === "legacy" || live.origin === "proposed"
        ? "takeover"
        : sameColumns(live, columns)
          ? "keep"
          : "update"
      : dead
        ? "revive"
        : "insert";
    plan.servers.push({
      name: server.name,
      action,
      id: row?.id ?? null,
      columns,
      enable:
        action === "insert" ||
        action === "revive" ||
        (action === "takeover" && live?.origin === "proposed"),
    });
    const previous = discoveredNames(row?.discoveredTools);

    for (const [key, entry] of Object.entries(server.tools).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const upstream = upstreamName(key, entry);
      let tool =
        snapshot.tools.find((t) => sameSlug(t.slug, entry.name)) ?? null;
      let renameFrom: string | null = null;
      if (!tool && action === "takeover" && row) {
        const legacySlug = `mcp.${row.id}.${upstream.trim().toLowerCase()}`;
        tool =
          snapshot.tools.find(
            (t) => sameSlug(t.slug, legacySlug) && !claimed.has(t.id),
          ) ?? null;
        if (tool) renameFrom = tool.slug;
      }
      if (tool) {
        if (tool.source !== "mcp")
          throw new ProjectionConflictError(entry.name, tool.source);
        claimed.add(tool.id);
      }
      const revive = tool !== null && tool.deletedAt !== null;
      // A new tool's insert already sets enabled, so its UPDATE matches no row.
      const enable =
        tool === null ||
        revive ||
        action === "revive" ||
        action === "insert" ||
        ((action === "update" || action === "keep") &&
          !previous.has(upstream));
      const facts = versionFacts(entry);
      const base = {
        server: server.name,
        fullName: entry.name,
        entry,
        facts,
        revive,
        renameFrom,
        enable,
      };
      const hex = entry.definition_hash.startsWith(SHA256_PREFIX)
        ? entry.definition_hash.slice(SHA256_PREFIX.length)
        : entry.definition_hash;
      const versions = tool
        ? snapshot.versions.filter((v) => v.toolId === tool.id)
        : [];
      const matched = versions
        .filter((v) => v.checksum === hex)
        .sort((a, b) => b.versionNumber - a.versionNumber)[0];
      if (!tool || !matched) {
        plan.tools.push({ ...base, tool, kind: "publish" });
        continue;
      }
      const activate = tool.activeVersionId !== matched.id;
      plan.tools.push({
        ...base,
        kind: "align",
        tool,
        version: matched,
        previousActive: activate
          ? (versions.find((v) => v.id === tool.activeVersionId) ?? null)
          : null,
        activate,
        reclassify: classificationDiffers(matched, facts),
        refreshManifest:
          canonicalJson(matched.manifest ?? null) !== canonicalJson(entry),
      });
    }

    // A tool of this server the folder no longer lists.
    if (row) {
      for (const tool of snapshot.tools) {
        if (
          tool.mcpServerId === row.id &&
          tool.deletedAt === null &&
          tool.enabled &&
          !claimed.has(tool.id) &&
          !disabled.has(tool.id)
        ) {
          disabled.add(tool.id);
          plan.disable.push({ id: tool.id, slug: tool.slug });
        }
      }
    }
  }

  // A steering server whose folder is gone. A legacy or proposed row that
  // carries a steering_name belongs to an open steering PR and is never
  // retired.
  for (const row of snapshot.servers) {
    if (
      row.origin !== "steering" ||
      row.deletedAt !== null ||
      manifestNames.has(row.steeringName) ||
      kept.has(row.steeringName)
    )
      continue;
    plan.retire.push({ id: row.id, name: row.steeringName });
    for (const tool of snapshot.tools) {
      if (
        tool.mcpServerId === row.id &&
        tool.deletedAt === null &&
        tool.enabled &&
        !claimed.has(tool.id) &&
        !disabled.has(tool.id)
      ) {
        disabled.add(tool.id);
        plan.disable.push({ id: tool.id, slug: tool.slug });
      }
    }
  }
  return plan;
}

// ── Reading and writing ─────────────────────────────────────────────────────

function emptySummary(): ProjectionSummary {
  return {
    servers: { inserted: 0, updated: 0, revived: 0, takenOver: 0, retired: 0 },
    tools: {
      published: 0,
      activated: 0,
      reclassified: 0,
      refreshed: 0,
      disabled: 0,
      enabled: 0,
    },
  };
}

function hexOf(hash: string): string {
  return hash.startsWith(SHA256_PREFIX) ? hash.slice(SHA256_PREFIX.length) : hash;
}

export async function loadSnapshot(
  tx: Tx,
  scope: { orgId: string; workspaceId: string },
  manifest: ToolManifest,
): Promise<RegistrySnapshot> {
  const { orgId, workspaceId } = scope;
  const servers = await tx
    .select({
      id: schema.mcpServers.id,
      name: schema.mcpServers.name,
      steeringName: schema.mcpServers.steeringName,
      origin: schema.mcpServers.origin,
      transportType: schema.mcpServers.transportType,
      endpointUrl: schema.mcpServers.endpointUrl,
      discoveredTools: schema.mcpServers.discoveredTools,
      enabled: schema.mcpServers.enabled,
      deletedAt: schema.mcpServers.deletedAt,
    })
    .from(schema.mcpServers)
    .where(
      and(
        eq(schema.mcpServers.orgId, orgId),
        eq(schema.mcpServers.workspaceId, workspaceId),
        isNotNull(schema.mcpServers.steeringName),
      ),
    );
  const serverIds = servers.map((s) => s.id);
  const names = manifest.servers.flatMap((s) =>
    Object.values(s.tools).map((t) => t.name),
  );
  const toolScopes: SQL[] = [];
  if (serverIds.length > 0)
    toolScopes.push(inArray(schema.tools.mcpServerId, serverIds));
  if (names.length > 0) toolScopes.push(inArray(schema.tools.slug, names));
  const tools =
    toolScopes.length === 0
      ? []
      : await tx
          .select({
            id: schema.tools.id,
            slug: schema.tools.slug,
            name: schema.tools.name,
            description: schema.tools.description,
            source: schema.tools.source,
            enabled: schema.tools.enabled,
            mcpServerId: schema.tools.mcpServerId,
            activeVersionId: schema.tools.activeVersionId,
            deletedAt: schema.tools.deletedAt,
          })
          .from(schema.tools)
          .where(
            and(
              eq(schema.tools.orgId, orgId),
              eq(schema.tools.workspaceId, workspaceId),
              or(...toolScopes),
            ),
          );
  const toolIds = tools.map((t) => t.id);
  const hexes = manifest.servers.flatMap((s) =>
    Object.values(s.tools).map((t) => hexOf(t.definition_hash)),
  );
  const activeIds = tools
    .map((t) => t.activeVersionId)
    .filter((id): id is string => id !== null);
  const versionScopes: SQL[] = [eq(schema.toolVersions.isLatest, true)];
  if (hexes.length > 0)
    versionScopes.push(inArray(schema.toolVersions.checksum, hexes));
  if (activeIds.length > 0)
    versionScopes.push(inArray(schema.toolVersions.id, activeIds));
  const versions =
    toolIds.length === 0
      ? []
      : await tx
          .select({
            id: schema.toolVersions.id,
            toolId: schema.toolVersions.toolId,
            versionNumber: schema.toolVersions.versionNumber,
            checksum: schema.toolVersions.checksum,
            riskGrade: schema.toolVersions.riskGrade,
            readOnly: schema.toolVersions.readOnly,
            impacts: schema.toolVersions.impacts,
            measures: schema.toolVersions.measures,
            manifest: schema.toolVersions.manifest,
            classification: schema.toolVersions.classification,
            classifiedRiskGrade: schema.toolVersions.classifiedRiskGrade,
          })
          .from(schema.toolVersions)
          .where(
            and(
              inArray(schema.toolVersions.toolId, toolIds),
              or(...versionScopes),
            ),
          );
  return {
    servers: servers.map((s) => ({
      ...s,
      steeringName: s.steeringName ?? "",
    })),
    tools,
    versions,
  };
}

function factsOf(slug: string, version: SnapshotVersion): ApprovalToolFacts {
  return {
    slug,
    version: version.versionNumber,
    impacts: version.impacts ?? [],
    measures: version.measures,
    classification: version.classification,
  };
}

async function applyPlan(
  tx: Tx,
  ctx: { orgId: string; workspaceId: string; version: number; now: Date },
  plan: ProjectionPlan,
): Promise<ProjectionSummary> {
  const { orgId, workspaceId, now } = ctx;
  const summary = emptySummary();
  const reason = `steering version ${ctx.version}`;
  const serverIds = new Map<string, string>();

  for (const step of plan.servers) {
    const c = step.columns;
    if (step.action === "insert" || step.id === null) {
      const [row] = await tx
        .insert(schema.mcpServers)
        .values({
          orgId,
          workspaceId,
          name: c.name,
          transportType: c.transportType,
          endpointUrl: c.endpointUrl,
          authStrategy: c.authStrategy,
          authConfig: {},
          healthStatus: "unknown",
          discoveredTools: c.discoveredTools,
          enabled: true,
          origin: "steering",
          steeringName: step.name,
        })
        .returning({ id: schema.mcpServers.id });
      if (!row) throw new Error("mcp_servers insert returned no row");
      serverIds.set(step.name, row.id);
      summary.servers.inserted += 1;
      continue;
    }
    serverIds.set(step.name, step.id);
    if (step.action === "keep") continue;
    await tx
      .update(schema.mcpServers)
      .set({
        name: c.name,
        transportType: c.transportType,
        endpointUrl: c.endpointUrl,
        discoveredTools: c.discoveredTools,
        origin: "steering",
        updatedAt: now,
        ...(step.action === "revive" ? { deletedAt: null, deletedById: null } : {}),
        ...(step.enable ? { enabled: true } : {}),
      })
      .where(eq(schema.mcpServers.id, step.id));
    if (step.action === "revive") summary.servers.revived += 1;
    else if (step.action === "takeover") summary.servers.takenOver += 1;
    else summary.servers.updated += 1;
  }

  for (const step of plan.tools) {
    const serverId = serverIds.get(step.server);
    if (!serverId) throw new Error(`no server row for ${step.server}`);
    const facts = step.facts;
    const description =
      step.entry.definition.description ??
      step.entry.definition.title ??
      step.fullName;

    // publishToolIn finds a tool by slug among live rows, so a revived row
    // and a renamed legacy slug are written first.
    if (step.tool && (step.revive || step.renameFrom)) {
      await tx
        .update(schema.tools)
        .set({
          ...(step.revive ? { deletedAt: null, deletedById: null } : {}),
          ...(step.renameFrom ? { slug: step.fullName } : {}),
          updatedAt: now,
        })
        .where(eq(schema.tools.id, step.tool.id));
    }

    if (step.kind === "publish") {
      const result = await publishToolIn(tx, {
        orgId,
        workspaceId,
        userId: null,
        name: step.fullName,
        slug: step.fullName,
        checksum: hexOf(step.entry.definition_hash),
        description,
        inputSchema: step.entry.definition.inputSchema as Record<
          string,
          unknown
        >,
        readOnly: facts.readOnly,
        riskGrade: facts.risk,
        policyGroup: null,
        manifest: step.entry as unknown as Record<string, unknown>,
        source: "mcp",
        mcpServerId: serverId,
        schemaOrigin: "imported",
        capability: PROJECT_CAPABILITY,
        classification: {
          riskGrade: facts.risk,
          classification: facts.classification,
          classifiedAt: now,
          classifiedByUserId: null,
          classificationReason: reason,
        },
        impacts: facts.impacts,
        // tools.toml's measures live in the classification. The mandate
        // gate's measure declarations are a different shape, so the version
        // declares none.
        measures: {},
        effectIdPath: null,
      });
      if (result.published) summary.tools.published += 1;
    } else {
      const tool = step.tool;
      const identity: {
        name?: string;
        description?: string;
        mcpServerId?: string;
      } = {};
      if (tool.name !== step.fullName) identity.name = step.fullName;
      if (tool.description !== description) identity.description = description;
      if (tool.mcpServerId !== serverId) identity.mcpServerId = serverId;
      const identityChanged = Object.keys(identity).length > 0;

      if (step.reclassify || step.refreshManifest) {
        await tx
          .update(schema.toolVersions)
          .set({
            manifest: step.entry as unknown as Record<string, unknown>,
            updatedAt: now,
            ...(step.reclassify
              ? {
                  classification: facts.classification,
                  classifiedRiskGrade: facts.risk,
                  riskGrade: facts.risk,
                  readOnly: facts.readOnly,
                  impacts: [...facts.impacts],
                  classifiedAt: now,
                  classifiedByUserId: null,
                  classificationReason: reason,
                }
              : {}),
          })
          .where(eq(schema.toolVersions.id, step.version.id));
      }
      if (step.activate || identityChanged) {
        await tx
          .update(schema.tools)
          .set({
            ...identity,
            updatedAt: now,
            ...(step.activate
              ? {
                  activeVersionId: step.version.id,
                  activatedAt: now,
                  activatedByUserId: null,
                }
              : {}),
          })
          .where(eq(schema.tools.id, tool.id));
      }
      if (step.activate) summary.tools.activated += 1;
      if (step.reclassify) summary.tools.reclassified += 1;
      else if (step.refreshManifest || identityChanged)
        summary.tools.refreshed += 1;

      if (step.activate || step.reclassify) {
        const before = step.activate
          ? step.previousActive
            ? factsOf(step.fullName, step.previousActive)
            : null
          : factsOf(step.fullName, step.version);
        await invalidateApprovalRules(tx, {
          orgId,
          workspaceId,
          actorUserId: null,
          capability: PROJECT_CAPABILITY,
          before,
          after: {
            slug: step.fullName,
            version: step.version.versionNumber,
            impacts: step.reclassify
              ? facts.impacts
              : (step.version.impacts ?? []),
            measures: step.version.measures,
            classification: step.reclassify
              ? facts.classification
              : step.version.classification,
          },
        });
      }
    }

    if (step.enable) {
      const enabled = await tx
        .update(schema.tools)
        .set({ enabled: true, updatedAt: now })
        .where(
          and(
            eq(schema.tools.orgId, orgId),
            eq(schema.tools.workspaceId, workspaceId),
            eq(schema.tools.slug, step.fullName),
            isNull(schema.tools.deletedAt),
            eq(schema.tools.enabled, false),
          ),
        )
        .returning({ id: schema.tools.id });
      summary.tools.enabled += enabled.length;
    }
  }

  const disableIds = plan.disable.map((t) => t.id);
  if (disableIds.length > 0) {
    const disabled = await tx
      .update(schema.tools)
      .set({ enabled: false, updatedAt: now })
      .where(
        and(inArray(schema.tools.id, disableIds), eq(schema.tools.enabled, true)),
      )
      .returning({ id: schema.tools.id });
    summary.tools.disabled += disabled.length;
  }
  const retireIds = plan.retire.map((s) => s.id);
  if (retireIds.length > 0) {
    const retired = await tx
      .update(schema.mcpServers)
      .set({ deletedAt: now, deletedById: null, updatedAt: now })
      .where(
        and(
          inArray(schema.mcpServers.id, retireIds),
          isNull(schema.mcpServers.deletedAt),
        ),
      )
      .returning({ id: schema.mcpServers.id });
    summary.servers.retired += retired.length;
  }
  return summary;
}

/** The workspace a bundle names, by its organization and workspace slugs. */
async function resolveWorkspace(
  organization: string,
  workspace: string,
): Promise<{ orgId: string; workspaceId: string }> {
  // tenancy: system bypass via withSystemDb (bootstrap: a steering publish
  // names its workspace by slug, so no tenant scope exists until this read
  // returns the orgId and workspaceId; it is filtered by both slugs and reads
  // ids only) (see docs/specs/tenancy-rls/spec.md)
  const rows = await withSystemDb(async (tx) =>
    tx
      .select({
        orgId: schema.organizations.id,
        workspaceId: schema.workspaces.id,
      })
      .from(schema.workspaces)
      .innerJoin(
        schema.organizations,
        eq(schema.organizations.id, schema.workspaces.orgId),
      )
      .where(
        and(
          eq(schema.organizations.slug, organization),
          eq(schema.workspaces.slug, workspace),
        ),
      )
      .limit(1),
  );
  const row = rows[0];
  if (!row)
    throw new Error(
      `No workspace ${organization}/${workspace} exists for this steering version.`,
    );
  return row;
}

/**
 * Write a published steering version's tools into the registry. S5's publish
 * and restore call it with the version's bundle and its server folders.
 *
 * Returns null when there is nothing to project: an organization's bundle,
 * or a bundle whose tools did not compile when no folder list came with it.
 */
export async function project(
  bundle: Bundle,
  options: ProjectOptions = {},
): Promise<ProjectionSummary | null> {
  if (bundle.scope !== "workspace" || !bundle.workspace) return null;
  if (bundle.tools === null && options.folders === undefined) return null;
  // A version whose tools did not compile carries no manifest. With the
  // folder list, the servers whose folders remain are left as they are and
  // the rest retire.
  const manifest: ToolManifest =
    bundle.tools === null
      ? { schema: "tool-manifest/v1", servers: [] }
      : toolManifestSchema.parse(bundle.tools);
  const now = options.now ?? new Date();
  const { orgId, workspaceId } = await resolveWorkspace(
    bundle.organization,
    bundle.workspace,
  );
  const summary = await runInTenantScope(
    {
      orgId,
      workspaceId,
      principalKind: "service",
      capabilityName: PROJECT_CAPABILITY,
    },
    () =>
      withTenantDb(async (tx) => {
        await lockWorkspaceRuleSet(tx, workspaceId);
        const snapshot = await loadSnapshot(
          tx,
          { orgId, workspaceId },
          manifest,
        );
        const plan = planProjection(manifest, snapshot, {
          folders: options.folders,
        });
        return applyPlan(
          tx,
          { orgId, workspaceId, version: bundle.version, now },
          plan,
        );
      }),
  );
  logger.info(
    { workspaceId, version: bundle.version, summary },
    "mcp-studio: projected steering version",
  );
  return summary;
}
