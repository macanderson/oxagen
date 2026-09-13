// The live tools adapter (Batch 3 lane A4, plan §3.1 Tools rows).
//
// Wired: servers (mcp.mcp_servers + mcp.tool_snapshots + mcp.credentials),
// toolVersions (agent.tools × agent.tool_versions, mcp.tool_snapshots),
// connections (ingestion.source_connections, mcp.credentials) and killSwitches
// (iam.emergency_denies).
//
// IAM decides first. Every wired read resolves the signed-in person (no session
// is `denied`) and calls the capability that owns its tables through the kernel,
// as that person, inside the tenant scope:
//
//   servers       list_mcp_servers
//   toolVersions  list_tool_declarations (every page) and list_mcp_servers
//   connections   list_connections and list_mcp_servers (mcp.credentials is an
//                 MCP server's credential and has no read contract of its own)
//   killSwitches  list_iam_roles (iam.emergency_denies has no read contract; an
//                 emergency deny is IAM configuration, so the read needs the
//                 same grant as reading the org's roles and grants)
//
// A kernel denial (authz_denied, pending_approval, surface_denied,
// capability_not_installed) is `denied(tools.read)` and the store is never
// reached. Only after every capability allowed the call does the adapter read
// the columns those contracts' outputs leave out (`enabled`, the listing a
// credential belongs to, the version history) through withTenantDb, and only
// for the ids the capabilities returned. Rows then map to drafts and settle
// through the view-model schema: a field today's stores do not record makes the
// read `not_backed` rather than a fabricated value (mappers/tools.ts).
//
// Not backed: observed schemas, the mandate ledger (G1), policy versions and
// simulation (G2), auto-approval rules (G12) and the assurance suite.
import "server-only";
import type { Tx } from "@oxagen/database";
import {
  type CapabilityContext,
  CapabilityError,
  getCapability,
  invoke,
} from "@oxagen/oxagen";
import { agentMcpList } from "@oxagen/oxagen/contracts/agent.mcp.list";
import { connectionList } from "@oxagen/oxagen/contracts/connection.list";
import { iamRoleList } from "@oxagen/oxagen/contracts/iam.role.list";
import { toolDeclarationList } from "@oxagen/oxagen/contracts/tool.declaration.list";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { z } from "zod";
import { notBackedFor } from "@/data/backing";
import {
  Connection,
  KillSwitch,
  ToolServer,
  ToolVersion,
} from "@/data/contracts";
import { denied, type Read, readError, readOk } from "@/data/not-backed";
import { PAGE_FAILURES } from "@/data/page-states";
import type { ToolReadPort } from "@/data/ports";
import { ContractOutputMismatch, ToolNotRegistered } from "@/server/errors";
import type { ToolContract } from "@/server/invoke";
import { getSession } from "@/server/session";
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

/** The public ids the capabilities returned: the only rows a store read may touch. */
export type ServerGrant = { serverPublicIds: readonly string[] };
export type ToolVersionGrant = ServerGrant & {
  toolPublicIds: readonly string[];
};
export type ConnectionGrant = ServerGrant & {
  connectionPublicIds: readonly string[];
};

/** The rows each wired read needs, already scoped to one workspace and one grant. */
export type ToolsStore = {
  servers(scope: Scope, grant: ServerGrant): Promise<ServerSource[]>;
  toolVersions(
    scope: Scope,
    grant: ToolVersionGrant,
  ): Promise<{
    declared: DeclaredToolSource[];
    imported: ImportedToolSource[];
  }>;
  connections(
    scope: Scope,
    grant: ConnectionGrant,
  ): Promise<{
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

/** Invoke a read capability as `userId` in `scope`; the result is parsed by the contract's output schema. */
export type InvokeRead = <I, O>(call: {
  scope: Scope;
  userId: string;
  contract: ToolContract<I, O>;
  input: NoInfer<I>;
}) => Promise<O>;

export type LiveToolsDeps = {
  /** The signed-in person's user id; null without a session. */
  principal: () => Promise<string | null>;
  invoke: InvokeRead;
  store: ToolsStore;
  /** Where a failed or unmappable read is reported; the page gets a state. */
  report: (error: unknown, context: string) => void;
  views?: ToolViews;
};

/** A workspace page read under the organization-only sentinel scope. */
export const WORKSPACE_SCOPE_REQUIRED = "workspace_scope_required";
/** The mapper produced a value the view model rejects: a defect, not an outage. */
export const TOOL_REGISTRY_UNMAPPABLE = "tool_registry_unmappable";

const TOOLS = PAGE_FAILURES.tools;

/** Kernel codes that mean "this person may not read this", not "the store failed". */
const DENIAL_CODES: ReadonlySet<string> = new Set([
  "authz_denied",
  "pending_approval",
  "surface_denied",
  "capability_not_installed",
]);

export function isCapabilityDenial(error: unknown): boolean {
  return error instanceof CapabilityError && DENIAL_CODES.has(error.code);
}

/** The largest page list_tool_declarations serves. */
const DECLARATION_PAGE = 200;

type WiredMethod = "servers" | "toolVersions" | "connections" | "killSwitches";

/** A capability call already bound to the viewer and the scope. */
type Call = <I, O>(
  contract: ToolContract<I, O>,
  input: NoInfer<I>,
) => Promise<O>;

/**
 * Wait for both capability calls. A denial from either wins over any other
 * failure, so a read the viewer may not make is never reported as an outage.
 */
async function both<A, B>(a: Promise<A>, b: Promise<B>): Promise<[A, B]> {
  const [ra, rb] = await Promise.allSettled([a, b]);
  if (ra.status === "fulfilled" && rb.status === "fulfilled")
    return [ra.value, rb.value];
  const failures = [ra, rb].flatMap((r) =>
    r.status === "rejected" ? [r.reason as unknown] : [],
  );
  throw failures.find(isCapabilityDenial) ?? failures[0];
}

async function serverGrant(call: Call): Promise<ServerGrant> {
  const { servers } = await call(agentMcpList, {});
  return { serverPublicIds: servers.map((s) => s.publicId) };
}

/** Every declaration the viewer may list, page by page. */
async function declaredToolIds(call: Call): Promise<string[]> {
  const ids: string[] = [];
  for (;;) {
    const page = await call(toolDeclarationList, {
      limit: DECLARATION_PAGE,
      offset: ids.length,
    });
    ids.push(...page.tools.map((t) => t.id));
    if (page.tools.length === 0 || ids.length >= page.total) return ids;
  }
}

export function createLiveTools(deps: LiveToolsDeps): ToolReadPort {
  const views: ToolViews = deps.views ?? {
    ToolServer,
    ToolVersion,
    Connection,
    KillSwitch,
  };

  async function read<G, S, T>(
    method: WiredMethod,
    scope: Scope,
    authorize: (call: Call) => Promise<G>,
    load: (scope: Scope, grant: G) => Promise<S>,
    draft: (rows: S) => unknown[],
    view: z.ZodType<T>,
  ): Promise<Read<T[]>> {
    if (isOrgOnlyScope(scope)) return readError(WORKSPACE_SCOPE_REQUIRED, 400);
    let rows: S;
    try {
      const userId = await deps.principal();
      if (userId === null) return denied(TOOLS.permission);
      const call: Call = (contract, input) =>
        deps.invoke({ scope, userId, contract, input });
      let grant: G;
      try {
        grant = await authorize(call);
      } catch (error) {
        if (isCapabilityDenial(error)) return denied(TOOLS.permission);
        if (
          error instanceof CapabilityError &&
          error.code === "invalid_output"
        ) {
          // The capability allowed the read, but its own contract rejects a
          // stored value (list_mcp_servers and `sse`/`unknown`): a defect.
          deps.report(error, `tools.${method} capability output rejected`);
          return readError(TOOL_REGISTRY_UNMAPPABLE, 500);
        }
        throw error;
      }
      rows = await load(scope, grant);
    } catch (error) {
      deps.report(error, `tools.${method} read failed`);
      return readError(TOOLS.error.code, TOOLS.error.status);
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
        serverGrant,
        (s, grant) => deps.store.servers(s, grant),
        (rows) => rows.map(toToolServer),
        views.ToolServer,
      ),
    toolVersions: (scope, q) =>
      read(
        "toolVersions",
        scope,
        async (call) => {
          const [toolPublicIds, servers] = await both(
            declaredToolIds(call),
            serverGrant(call),
          );
          return { ...servers, toolPublicIds };
        },
        (s, grant) => deps.store.toolVersions(s, grant),
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
        async (call) => {
          const [listed, servers] = await both(
            call(connectionList, {}),
            serverGrant(call),
          );
          return {
            ...servers,
            connectionPublicIds: listed.connections.map((c) => c.publicId),
          };
        },
        (s, grant) => deps.store.connections(s, grant),
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
        async (call) => {
          // The roles themselves are not needed: the call is the IAM decision.
          await call(iamRoleList, { includeGrants: false, limit: 1 });
        },
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
 * Distinct descriptors per (server, tool) with their first and last capture,
 * for the granted servers only. jsonb equality ignores key order, so a
 * re-capture of the same descriptor groups with the original. Snapshots of
 * soft-deleted servers are retained for replay and are not part of the live
 * registry.
 */
function snapshotDescriptors(
  tx: Tx,
  s: Schema,
  scope: Scope,
  grant: ServerGrant,
) {
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
        inArray(s.mcpServers.publicId, [...grant.serverPublicIds]),
      ),
    )
    .groupBy(s.mcpServers.publicId, snap.toolName, snap.schemaJson);
}

export const postgresToolsStore: ToolsStore = {
  servers: (scope, grant) =>
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
            inArray(s.mcpServers.publicId, [...grant.serverPublicIds]),
          ),
        )
        .orderBy(s.mcpServers.name);
      const descriptors = await snapshotDescriptors(tx, s, scope, grant);
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

  toolVersions: (scope, grant) =>
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
            inArray(s.tools.publicId, [...grant.toolPublicIds]),
          ),
        )
        .orderBy(s.tools.slug, s.toolVersions.versionNumber);
      const imported = await snapshotDescriptors(tx, s, scope, grant);
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

  connections: (scope, grant) =>
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
            inArray(sc.publicId, [...grant.connectionPublicIds]),
          ),
        )
        .orderBy(sc.createdAt);
      // Every MCP credential in the workspace (list_mcp_servers allowed the
      // read), attached only to a server that call returned.
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
            inArray(s.mcpServers.publicId, [...grant.serverPublicIds]),
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
export async function reportToTelemetry(error: unknown, context: string) {
  try {
    const { captureError } = await import("@oxagen/telemetry");
    captureError({ error, source: "app", severity: "error", context });
  } catch {
    // Error capture must never become a new failure inside a read.
  }
}

let handlersRegistered: Promise<unknown> | null = null;

/**
 * Load both handler registries once. list_mcp_servers is bound by
 * @oxagen/agent, the rest by @oxagen/handlers; without the register module the
 * kernel finds no handler (the rule src/server/invoke.ts follows).
 */
function registerHandlers(): Promise<unknown> {
  handlersRegistered ??= Promise.all([
    import("@oxagen/handlers/register"),
    import("@oxagen/agent/register"),
  ]);
  return handlersRegistered;
}

/** The production I/O: the request's session, the kernel, and tenant-scoped Postgres. */
export const liveToolsDeps: LiveToolsDeps = {
  async principal() {
    return (await getSession())?.user.id ?? null;
  },

  async invoke({ scope, userId, contract, input }) {
    await registerHandlers();
    if (!getCapability(contract.name))
      throw new ToolNotRegistered(contract.name);
    const ctx: CapabilityContext = {
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      userId,
      apiKeyId: null,
      requestId: crypto.randomUUID(),
      surface: "app",
      messageId: null,
    };
    const { runInTenantScope } = await import("@oxagen/tenancy");
    const raw = await runInTenantScope(scope, () =>
      invoke(contract.name, input, ctx),
    );
    const parsed = contract.output.safeParse(raw);
    if (!parsed.success)
      throw new ContractOutputMismatch(contract.name, parsed.error.issues);
    return parsed.data;
  },

  store: postgresToolsStore,
  report: (error, context) => void reportToTelemetry(error, context),
};

export const liveTools: ToolReadPort = createLiveTools(liveToolsDeps);
