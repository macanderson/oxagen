// tool.try.ports.ts: the production ports try_studio_tool runs on.
//
// Each port reads what the served call path (apps/mcp/src/servers/ports.ts)
// reads, from the same tables, so a Try it call is decided on the same facts
// an agent's call would be. The tests bind fakes to TryStudioToolDeps, so
// nothing here holds logic a test needs to reach.
import { createKillSwitchGate, postgresKillSwitchReads } from "@oxagen/agent/runtime/kill-switch-gate";
import { registryCapabilityId } from "@oxagen/agent/runtime/tool-registry-facts";
import { schema, withTenantDb } from "@oxagen/database";
import { createCloudTransport, toolManifestSchema, type CredentialSource, type Transport } from "@oxagen/mcp-studio";
import { HandlerError } from "@oxagen/oxagen";
import { parseCredentialRef } from "@oxagen/oxagen/steering-repo/names";
import type { CedarRuntime } from "@oxagen/policy";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { operatorRoleOf } from "../../lib/operator-role";
import { logger } from "../../logger";
import { steeringRepositoryKey } from "../../steering-repo/publisher";
import { postgresVersionStore } from "../../steering-repo/version-store";
import { toolsSteeringHost, type ToolsPullRequestScope } from "../../tools.pr.open";
import { workspaceCredentialSource } from "../credentials/connect";
import { authorizeStudio } from "./checks";
import { workspaceCredentials } from "./review.open";
import { importSource } from "./source";
import { postgresStudioDraftStore } from "./store";
import { createTryStudioToolHandler, type PublishedSteering, type TryStudioToolDeps } from "./tool.try";

/**
 * The published version of the draft's repository. A bundle from an
 * organization repository names no workspace, and serves no tool, so it
 * reads as nothing published.
 */
async function readPublished(
  scope: ToolsPullRequestScope,
  repo: Parameters<TryStudioToolDeps["published"]>[1],
): Promise<PublishedSteering | null> {
  const bundle = await postgresVersionStore(scope).current(steeringRepositoryKey(repo));
  if (bundle === null || bundle.workspace === undefined) return null;
  let servers: PublishedSteering["servers"] = [];
  if (bundle.tools !== null) {
    const manifest = toolManifestSchema.safeParse(bundle.tools);
    if (!manifest.success) {
      throw new HandlerError({
        code: "conflict",
        reason: "published_manifest_invalid",
        message: `Steering version ${bundle.version}'s tool manifest does not read as one, so Oxagen cannot decide the call. Publish the steering repo again, then try the tool.`,
      });
    }
    servers = manifest.data.servers;
  }
  return {
    workspace: bundle.workspace,
    version: bundle.version,
    servers,
    policies: (bundle.policies?.policies ?? []).map(({ path, text }) => ({ path, text })),
    agents: bundle.agents.map(({ name, operator, runtime, harness }) => ({ name, operator, runtime, harness })),
  };
}

/** The module's evaluator, or its default export's, or null. */
function asCedarRuntime(mod: unknown): CedarRuntime | null {
  const evaluates = (value: unknown): value is CedarRuntime =>
    typeof value === "object" && value !== null && typeof (value as { isAuthorized?: unknown }).isAuthorized === "function";
  if (evaluates(mod)) return mod;
  const fallback = typeof mod === "object" && mod !== null ? (mod as { default?: unknown }).default : undefined;
  return evaluates(fallback) ? fallback : null;
}

let cedar: Promise<CedarRuntime | null> | undefined;

/** Cedar's evaluator, loaded once per process. A failed load is not cached, so the next call tries again. */
function loadCedar(): Promise<CedarRuntime | null> {
  cedar ??= import("@cedar-policy/cedar-wasm/nodejs").then(asCedarRuntime, () => null).then((runtime) => {
    if (runtime === null) cedar = undefined;
    return runtime;
  });
  return cedar;
}

/** The servers and tools a workspace admin switched off in Oxagen. */
function readOffSwitches(scope: ToolsPullRequestScope): ReturnType<TryStudioToolDeps["off"]> {
  return runInTenantScope(scope, () =>
    withTenantDb(async (tx) => {
      const servers = schema.mcpServers;
      const serverRows = await tx
        .select({ name: servers.steeringName })
        .from(servers)
        .where(
          and(
            eq(servers.orgId, scope.orgId),
            eq(servers.workspaceId, scope.workspaceId),
            eq(servers.enabled, false),
            isNull(servers.deletedAt),
            isNotNull(servers.steeringName),
          ),
        );
      const tools = schema.tools;
      const toolRows = await tx
        .select({ name: tools.slug })
        .from(tools)
        .where(
          and(
            eq(tools.orgId, scope.orgId),
            eq(tools.workspaceId, scope.workspaceId),
            isNotNull(tools.mcpServerId),
            eq(tools.enabled, false),
            isNull(tools.deletedAt),
          ),
        );
      return {
        servers: new Set(serverRows.flatMap((row) => (row.name === null ? [] : [row.name]))),
        tools: new Set(toolRows.map((row) => row.name)),
      };
    }),
  );
}

/**
 * The registry rows a kill switch names for the call: the steering server's
 * mcp.mcp_servers row, and the mcp.mcp_credentials row its credential
 * reference names, whatever the credential's status.
 */
function readSwitchTargets(
  scope: ToolsPullRequestScope,
  call: { server: string; credential: string | null },
): Promise<{ serverId: string | null; connectionId: string | null }> {
  const name = call.credential === null ? null : parseCredentialRef(call.credential);
  return runInTenantScope(scope, () =>
    withTenantDb(async (tx) => {
      const servers = schema.mcpServers;
      const [server] = await tx
        .select({ id: servers.id })
        .from(servers)
        .where(
          and(
            eq(servers.orgId, scope.orgId),
            eq(servers.workspaceId, scope.workspaceId),
            eq(servers.steeringName, call.server),
            isNull(servers.deletedAt),
          ),
        )
        .limit(1);
      let connectionId: string | null = null;
      if (name !== null) {
        const credentials = schema.mcpCredentials;
        const [credential] = await tx
          .select({ id: credentials.id })
          .from(credentials)
          .where(
            and(
              eq(credentials.orgId, scope.orgId),
              eq(credentials.workspaceId, scope.workspaceId),
              eq(credentials.name, name),
            ),
          )
          .limit(1);
        connectionId = credential?.id ?? null;
      }
      return { serverId: server?.id ?? null, connectionId };
    }),
  );
}

const emergencyDeny: TryStudioToolDeps["emergencyDeny"] = async (ctx, call) => {
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  const { serverId, connectionId } = await readSwitchTargets(scope, call);
  const hit = await createKillSwitchGate(ctx, postgresKillSwitchReads).check({
    capabilityId: registryCapabilityId({ source: "mcp", slug: call.tool, name: call.tool, mcpServerId: serverId }),
    serverId,
    connectionId,
    readOnly: call.readOnly,
  });
  return hit === null ? null : { id: hit.publicId, targetKind: hit.targetKind, targetId: hit.targetId, reason: hit.reason };
};

/** The person's workspace role, as a policy's operator_role reads it. */
async function readOperatorRole(scope: ToolsPullRequestScope, userId: string): Promise<string | undefined> {
  const [member] = await runInTenantScope(scope, () =>
    withTenantDb((tx) =>
      tx
        .select({ role: schema.workspaceUsers.role })
        .from(schema.workspaceUsers)
        .where(and(eq(schema.workspaceUsers.workspaceId, scope.workspaceId), eq(schema.workspaceUsers.userId, userId)))
        .limit(1),
    ),
  );
  return operatorRoleOf(member?.role) ?? undefined;
}

/** The slugs of the workspace and its organization, which a connect link names. */
async function scopeSlugs(scope: ToolsPullRequestScope): Promise<{ orgSlug: string; workspaceSlug: string }> {
  const [row] = await runInTenantScope(scope, () =>
    withTenantDb((tx) =>
      tx
        .select({ orgSlug: schema.organizations.slug, workspaceSlug: schema.workspaces.slug })
        .from(schema.workspaces)
        .innerJoin(schema.organizations, eq(schema.organizations.id, schema.workspaces.orgId))
        .where(and(eq(schema.workspaces.id, scope.workspaceId), eq(schema.workspaces.orgId, scope.orgId)))
        .limit(1),
    ),
  );
  if (row === undefined) throw new Error("The workspace does not exist.");
  return row;
}

/**
 * The vault's CredentialSource for the workspace. It reads the published
 * servers, as a served call's does, and its connect link is on the app's
 * origin, where the operator's session cookie lives.
 */
function credentialSource(scope: ToolsPullRequestScope): CredentialSource {
  return {
    async resolve(request, signal) {
      const source = await workspaceCredentialSource({ ...scope, ...(await scopeSlugs(scope)) });
      return source.resolve(request, signal);
    },
  };
}

let cloud: Transport | undefined;

/** One cloud transport per process, so its connections are reused between calls. */
function cloudTransport(): Transport {
  cloud ??= createCloudTransport();
  return cloud;
}

export const tryStudioToolHandler = createTryStudioToolHandler({
  store: postgresStudioDraftStore(),
  authorize: authorizeStudio,
  host: toolsSteeringHost,
  credentials: workspaceCredentials,
  importSource: (source) => importSource(source),
  published: readPublished,
  cedar: loadCedar,
  off: readOffSwitches,
  emergencyDeny,
  operatorRole: readOperatorRole,
  credentialSource,
  transport: cloudTransport,
  log: { warn: (fields, message) => logger.warn(fields, message) },
});
