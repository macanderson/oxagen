// The live tools adapter (Batch 3 lane A4, plan §3.1 Tools rows).
//
// Wired: servers (mcp.mcp_servers + mcp.tool_snapshots + mcp.credentials),
// toolVersions (agent.tools × agent.tool_versions, mcp.tool_snapshots),
// connections (ingestion.source_connections, mcp.credentials) and killSwitches
// (iam.emergency_denies). Each read runs inside the viewer's tenant scope
// (runInTenantScope → withTenantDb, so RLS and the explicit org/workspace
// predicates both apply), maps rows to drafts, and settles them through the
// view-model schema: a field today's stores do not record makes the read
// `not_backed` rather than a fabricated value (mappers/tools.ts).
//
// The reads cover the same tables as the agent tools list_mcp_servers,
// list_tool_declarations, list_connections and list_plugin_registries, so the
// contract-first order holds. They are not kernel invokes: a read port carries
// a tenant scope and no principal, the kernel's IAM gate fails closed without
// one, and those contracts' outputs omit columns the view model needs
// (`enabled`, the listing a credential belongs to, the version history).
// iam.emergency_denies and mcp.tool_snapshots have no read contract at all.
//
// Not backed: observed schemas, the mandate ledger (G1), policy versions and
// simulation (G2), auto-approval rules (G12) and the assurance suite.
import "server-only";
import type { Tx } from "@oxagen/database";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { z } from "zod";
import { notBackedFor } from "@/data/backing";
import {
  Connection,
  KillSwitch,
  ToolServer,
  ToolVersion,
} from "@/data/contracts";
import { type Read, readError, readOk } from "@/data/not-backed";
import { PAGE_FAILURES } from "@/data/page-states";
import type { ToolReadPort } from "@/data/ports";
import { isOrgOnlyScope, type Scope } from "@/server/tenant-scope";
import {
  type DeclaredToolSource,
  type ImportedToolSource,
  type KillSwitchSource,
  type McpCredentialSource,
  type ServerSource,
  type SourceConnectionSource,
  settle,
  toDeclaredToolVersion,
  toImportedToolVersions,
  toKillSwitch,
  toMcpCredentialConnection,
  toSourceConnection,
  toToolServer,
} from "./mappers/tools";

/** The rows each wired read needs, already scoped to one workspace. */
export type ToolsStore = {
  servers(scope: Scope): Promise<ServerSource[]>;
  toolVersions(scope: Scope): Promise<{
    declared: DeclaredToolSource[];
    imported: ImportedToolSource[];
  }>;
  connections(scope: Scope): Promise<{
    sources: SourceConnectionSource[];
    credentials: McpCredentialSource[];
  }>;
  killSwitches(scope: Scope): Promise<KillSwitchSource[]>;
};

/** The view-model schemas reads settle through (injectable so a test can widen one). */
export type ToolViews = {
  ToolServer: z.ZodType<ToolServer>;
  ToolVersion: z.ZodType<ToolVersion>;
  Connection: z.ZodType<Connection>;
  KillSwitch: z.ZodType<KillSwitch>;
};

export type LiveToolsDeps = {
  store: ToolsStore;
  /** Where a failed or unmappable read is reported; the page gets a state. */
  report: (error: unknown, context: string) => void;
  views?: ToolViews;
};

/** A workspace page read under the organization-only sentinel scope. */
export const WORKSPACE_SCOPE_REQUIRED = "workspace_scope_required";
/** The mapper produced a value the view model rejects: a defect, not an outage. */
export const TOOL_REGISTRY_UNMAPPABLE = "tool_registry_unmappable";

const TOOLS_FAILURE = PAGE_FAILURES.tools.error;

type WiredMethod = "servers" | "toolVersions" | "connections" | "killSwitches";

export function createLiveTools(deps: LiveToolsDeps): ToolReadPort {
  const views: ToolViews = deps.views ?? {
    ToolServer,
    ToolVersion,
    Connection,
    KillSwitch,
  };

  async function read<S, T>(
    method: WiredMethod,
    scope: Scope,
    load: (scope: Scope) => Promise<S>,
    draft: (rows: S) => unknown[],
    view: z.ZodType<T>,
  ): Promise<Read<T[]>> {
    if (isOrgOnlyScope(scope)) return readError(WORKSPACE_SCOPE_REQUIRED, 400);
    let rows: S;
    try {
      rows = await load(scope);
    } catch (error) {
      deps.report(error, `tools.${method} read failed`);
      return readError(TOOLS_FAILURE.code, TOOLS_FAILURE.status);
    }
    const settled = settle(view, draft(rows));
    switch (settled.kind) {
      case "ok":
        return readOk(settled.value);
      case "unrecorded":
        return notBackedFor("tools", method);
      case "mismatch":
        deps.report(
          new Error(
            `tools.${method}: view model rejects mapped fields ${settled.paths.join(", ")}`,
          ),
          `tools.${method} unmappable`,
        );
        return readError(TOOL_REGISTRY_UNMAPPABLE, 500);
    }
  }

  return {
    servers: (scope) =>
      read(
        "servers",
        scope,
        (s) => deps.store.servers(s),
        (rows) => rows.map(toToolServer),
        views.ToolServer,
      ),
    toolVersions: (scope, q) =>
      read(
        "toolVersions",
        scope,
        (s) => deps.store.toolVersions(s),
        ({ declared, imported }) => {
          const drafts = [
            ...declared.map(toDeclaredToolVersion),
            ...toImportedToolVersions(imported),
          ];
          return q?.serverId === undefined
            ? drafts
            : drafts.filter((d) => d.serverId === q.serverId);
        },
        views.ToolVersion,
      ),
    connections: (scope) =>
      read(
        "connections",
        scope,
        (s) => deps.store.connections(s),
        ({ sources, credentials }) => [
          ...sources.map(toSourceConnection),
          ...credentials.map(toMcpCredentialConnection),
        ],
        views.Connection,
      ),
    killSwitches: (scope) =>
      read(
        "killSwitches",
        scope,
        (s) => deps.store.killSwitches(s),
        (rows) => rows.map(toKillSwitch),
        views.KillSwitch,
      ),
    observedSchemas: () =>
      Promise.resolve(notBackedFor("tools", "observedSchemas")),
    mandateLedger: () =>
      Promise.resolve(notBackedFor("tools", "mandateLedger")),
    policyVersions: () =>
      Promise.resolve(notBackedFor("tools", "policyVersions")),
    policySimulation: () =>
      Promise.resolve(notBackedFor("tools", "policySimulation")),
    autoApprovalRules: () =>
      Promise.resolve(notBackedFor("tools", "autoApprovalRules")),
    assurance: () => Promise.resolve(notBackedFor("tools", "assurance")),
  };
}

// ---- Postgres store ------------------------------------------------------------

type Schema = typeof import("@oxagen/database")["schema"];

/**
 * Enter the tenant scope, then one RLS-scoped transaction. The store packages
 * load lazily so fixture mode, which has no Postgres, never imports them.
 */
async function inTenant<T>(
  scope: Scope,
  fn: (tx: Tx, s: Schema) => Promise<T>,
): Promise<T> {
  const [{ schema, withTenantDb }, { runInTenantScope }] = await Promise.all([
    import("@oxagen/database"),
    import("@oxagen/tenancy"),
  ]);
  return runInTenantScope(scope, () => withTenantDb((tx) => fn(tx, schema)));
}

/**
 * Distinct descriptors per (server, tool) with their first and last capture.
 * jsonb equality ignores key order, so a re-capture of the same descriptor
 * groups with the original. Snapshots of soft-deleted servers are retained for
 * replay and are not part of the live registry.
 */
function snapshotDescriptors(tx: Tx, s: Schema, scope: Scope) {
  const snap = s.mcpToolSnapshots;
  return tx
    .select({
      serverPublicId: s.mcpServers.publicId,
      toolName: snap.toolName,
      schemaJson: snap.schemaJson,
      firstCapturedAt: sql<Date>`min(${snap.capturedAt})`.mapWith(
        snap.capturedAt,
      ),
      lastCapturedAt: sql<Date>`max(${snap.capturedAt})`.mapWith(
        snap.capturedAt,
      ),
    })
    .from(snap)
    .innerJoin(s.mcpServers, eq(s.mcpServers.id, snap.mcpServerId))
    .where(
      and(
        eq(snap.orgId, scope.orgId),
        eq(snap.workspaceId, scope.workspaceId),
        isNull(s.mcpServers.deletedAt),
      ),
    )
    .groupBy(s.mcpServers.publicId, snap.toolName, snap.schemaJson);
}

export const postgresToolsStore: ToolsStore = {
  servers: (scope) =>
    inTenant(scope, async (tx, s) => {
      const servers = await tx
        .select({
          publicId: s.mcpServers.publicId,
          name: s.mcpServers.name,
          transportType: s.mcpServers.transportType,
          endpointUrl: s.mcpServers.endpointUrl,
          healthStatus: s.mcpServers.healthStatus,
          discoveredTools: s.mcpServers.discoveredTools,
          enabled: s.mcpServers.enabled,
          orgListingId: s.mcpServers.orgListingId,
        })
        .from(s.mcpServers)
        .where(
          and(
            eq(s.mcpServers.orgId, scope.orgId),
            eq(s.mcpServers.workspaceId, scope.workspaceId),
            isNull(s.mcpServers.deletedAt),
          ),
        )
        .orderBy(s.mcpServers.name);
      const descriptors = await snapshotDescriptors(tx, s, scope);
      const credentials = await tx
        .select({
          publicId: s.mcpCredentials.publicId,
          orgListingId: s.mcpCredentials.orgListingId,
        })
        .from(s.mcpCredentials)
        .where(
          and(
            eq(s.mcpCredentials.orgId, scope.orgId),
            eq(s.mcpCredentials.workspaceId, scope.workspaceId),
          ),
        );
      return servers.map(({ orgListingId, ...server }) => {
        const own = descriptors.filter(
          (d) => d.serverPublicId === server.publicId,
        );
        const last = own.reduce<Date | null>(
          (max, d) =>
            max === null || d.lastCapturedAt > max ? d.lastCapturedAt : max,
          null,
        );
        return {
          server,
          snapshots: { descriptorCount: own.length, lastCapturedAt: last },
          credentialPublicId:
            orgListingId === null
              ? null
              : (credentials.find((c) => c.orgListingId === orgListingId)
                  ?.publicId ?? null),
        };
      });
    }),

  toolVersions: (scope) =>
    inTenant(scope, async (tx, s) => {
      const declared = await tx
        .select({
          slug: s.tools.slug,
          source: s.tools.source,
          versionNumber: s.toolVersions.versionNumber,
          riskGrade: s.toolVersions.riskGrade,
          readOnly: s.toolVersions.readOnly,
          checksum: s.toolVersions.checksum,
        })
        .from(s.toolVersions)
        .innerJoin(s.tools, eq(s.tools.id, s.toolVersions.toolId))
        .where(
          and(
            eq(s.tools.orgId, scope.orgId),
            eq(s.tools.workspaceId, scope.workspaceId),
            isNull(s.tools.deletedAt),
          ),
        )
        .orderBy(s.tools.slug, s.toolVersions.versionNumber);
      const imported = await snapshotDescriptors(tx, s, scope);
      return {
        declared: declared.map(({ slug, source, ...version }) => ({
          tool: { slug, source },
          version,
        })),
        imported: imported.map(
          ({ serverPublicId, toolName, schemaJson, firstCapturedAt }) => ({
            serverPublicId,
            toolName,
            schemaJson,
            firstCapturedAt,
          }),
        ),
      };
    }),

  connections: (scope) =>
    inTenant(scope, async (tx, s) => {
      const sc = s.sourceConnections;
      const sources = await tx
        .select({
          publicId: sc.publicId,
          displayName: sc.displayName,
          authScheme: sc.authScheme,
          status: sc.status,
          ownerPublicId: s.users.publicId,
        })
        .from(sc)
        .leftJoin(s.users, eq(s.users.id, sc.createdByUserId))
        .where(
          and(
            eq(sc.orgId, scope.orgId),
            eq(sc.workspaceId, scope.workspaceId),
            isNull(sc.deletedAt),
          ),
        )
        .orderBy(sc.createdAt);
      const cred = s.mcpCredentials;
      const credentials = await tx
        .select({
          publicId: cred.publicId,
          authKind: cred.authKind,
          status: cred.status,
          ownerPublicId: s.users.publicId,
          serverPublicId: s.mcpServers.publicId,
          serverName: s.mcpServers.name,
        })
        .from(cred)
        .leftJoin(
          s.mcpServers,
          and(
            eq(s.mcpServers.orgListingId, cred.orgListingId),
            eq(s.mcpServers.workspaceId, cred.workspaceId),
            isNull(s.mcpServers.deletedAt),
          ),
        )
        .leftJoin(s.users, eq(s.users.id, cred.createdByUserId))
        .where(
          and(
            eq(cred.orgId, scope.orgId),
            eq(cred.workspaceId, scope.workspaceId),
          ),
        )
        .orderBy(cred.createdAt);
      return {
        sources: sources.map(({ ownerPublicId, ...connection }) => ({
          connection,
          ownerPublicId,
        })),
        credentials: credentials.map(
          ({ ownerPublicId, serverPublicId, serverName, ...credential }) => ({
            credential,
            server:
              serverPublicId === null || serverName === null
                ? null
                : { publicId: serverPublicId, name: serverName },
            ownerPublicId,
          }),
        ),
      };
    }),

  killSwitches: (scope) =>
    inTenant(scope, async (tx, s) => {
      const ed = s.emergencyDenies;
      const activator = alias(s.users, "activator");
      const deactivator = alias(s.users, "deactivator");
      const rows = await tx
        .select({
          publicId: ed.publicId,
          denyKind: ed.denyKind,
          capabilityId: ed.capabilityId,
          resourceScopeDigest: ed.resourceScopeDigest,
          principalId: ed.principalId,
          reason: ed.reason,
          active: ed.active,
          activatedAt: ed.activatedAt,
          deactivatedAt: ed.deactivatedAt,
          activatedByPublicId: activator.publicId,
          deactivatedByPublicId: deactivator.publicId,
        })
        .from(ed)
        .leftJoin(activator, eq(activator.id, ed.createdByUserId))
        .leftJoin(deactivator, eq(deactivator.id, ed.updatedByUserId))
        .where(
          and(
            eq(ed.orgId, scope.orgId),
            // An organization-wide deny (workspace_id NULL) stops calls here too.
            or(eq(ed.workspaceId, scope.workspaceId), isNull(ed.workspaceId)),
          ),
        )
        .orderBy(desc(ed.activatedAt));
      return rows.map(
        ({ activatedByPublicId, deactivatedByPublicId, ...deny }) => ({
          deny,
          activatedByPublicId,
          deactivatedByPublicId,
        }),
      );
    }),
};

/** Report to the ClickHouse error stream; telemetry loads lazily, like the store. */
async function reportToTelemetry(error: unknown, context: string) {
  try {
    const { captureError } = await import("@oxagen/telemetry");
    captureError({ error, source: "app", severity: "error", context });
  } catch {
    // Error capture must never become a new failure inside a read.
  }
}

export const liveTools: ToolReadPort = createLiveTools({
  store: postgresToolsStore,
  report: (error, context) => void reportToTelemetry(error, context),
});
