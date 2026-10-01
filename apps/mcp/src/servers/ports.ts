// ports.ts: the production ports the served tools run on (lane M15;
// mcp-studio-spec, Call path).
//
// Each port reads or writes inside the run's tenant scope. The tests bind
// fakes to the same interfaces, so nothing here holds logic a test needs to
// reach: it reads rows, hands them on, and picks the transport the
// environment's network names.
import { postgresKillSwitchReads } from "@oxagen/agent/runtime/kill-switch-gate";
import { assertGauAvailable, BillingSuspendedError, GauExhaustedError, recordGovernedActions } from "@oxagen/billing";
import { schema, withTenantDb } from "@oxagen/database";
import { readSteeringConnection } from "@oxagen/handlers/context.steering.host";
import { operatorRoleOf } from "@oxagen/handlers/lib/operator-role";
import { workspaceCredentialSource } from "@oxagen/handlers/mcp-studio/credentials/connect";
import { readWorkspaceWithheldTools } from "@oxagen/handlers/mcp-studio/discovery/store";
import { searchIndexFor } from "@oxagen/handlers/mcp-studio/search-index";
import { postgresVersionStore } from "@oxagen/handlers/steering-repo/version-store";
import { readKeyScope, TACHO_GATEWAY_PURPOSE } from "@oxagen/iam/machine-key-scope";
import { createCloudTransport, type CredentialSource, type Transport } from "@oxagen/mcp-studio";
import { parseCredentialRef } from "@oxagen/oxagen/steering-repo/names";
import type { CedarRuntime } from "@oxagen/policy";
import { recordServedToolCall } from "@oxagen/telemetry";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { productionLocalTransport } from "../local-servers";
import { relayTransport } from "../relay";
import { postgresApprovals } from "./approvals";
import { asCedarRuntime } from "./cedar";
import { lazyCredentialSource } from "./credentials";
import { servedRanker } from "./embeddings";
import { servedEmergencyDenies, type SwitchTargets } from "./kill-switch";
import { METER_LABEL, meterEntry, servedCallRow } from "./meter";
import type { PublishedSources } from "./published";
import type { RunSources, ServedHost } from "./run";
import {
  type Admission,
  type MeterEvent,
  type OffSwitches,
  type ServedCallRecord,
  type ServedLog,
  type ServedPorts,
  type ServedRoute,
  type ServedRun,
  type ServedTransport,
} from "./types";

type Scope = { orgId: string; workspaceId: string };

function scopeOf(run: ServedRun): Scope {
  return { orgId: run.orgId, workspaceId: run.workspaceId };
}

/** The servers and tools a workspace admin switched off in Oxagen. */
export function readOffSwitches(run: ServedRun): Promise<OffSwitches> {
  const scope = scopeOf(run);
  return runInTenantScope(scope, () =>
    withTenantDb(async (tx): Promise<OffSwitches> => {
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
 * The registry rows a kill switch names for one call: the steering server's
 * mcp.mcp_servers row, and the mcp.mcp_credentials row its credential
 * reference names. A deleted server matches nothing. A credential is found
 * whatever its status, so a switch on a revoked connection still reads as on.
 */
export function readSwitchTargets(
  run: ServedRun,
  call: { server: string; credential: string | null },
): Promise<SwitchTargets> {
  const scope = scopeOf(run);
  const name = call.credential === null ? null : parseCredentialRef(call.credential);
  return runInTenantScope(scope, () =>
    withTenantDb(async (tx): Promise<SwitchTargets> => {
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

/** The slugs of the run's organization and workspace, which a connect link names. */
async function scopeSlugs(scope: Scope): Promise<{ orgSlug: string; workspaceSlug: string }> {
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
  if (row === undefined) throw new Error("The run's workspace does not exist.");
  return row;
}

/**
 * The vault's CredentialSource for one run, built on the first call that
 * needs a credential. Its connect link is on the app's origin, where the
 * operator's session cookie lives (`mcpStudioAppOrigin`).
 */
export function servedCredentials(run: ServedRun): CredentialSource {
  const scope = scopeOf(run);
  return lazyCredentialSource(async () =>
    workspaceCredentialSource({ ...scope, ...(await scopeSlugs(scope)) }),
  );
}

let cloud: Transport | undefined;

/** The transport for the network the environment names. */
export function transportFor(route: ServedRoute): ServedTransport {
  // A local call waits in this process's broker until the machine's
  // long-poll picks it up (local-servers/broker.ts says why one process).
  if (route.network === "local") return productionLocalTransport(route);
  // A relay:<name> network goes through this process's relay broker (lane M12).
  // Its transport can refuse a call before runTool claims an approval.
  if (route.network.startsWith("relay:")) return relayTransport(route);
  cloud ??= createCloudTransport();
  return cloud;
}

/**
 * Billing's admission for one governed action: the gate the kernel and the
 * external tool path run first (ADR-055, ADR-165). It charges nothing.
 */
export async function admitServed(run: ServedRun): Promise<Admission> {
  try {
    await runInTenantScope(scopeOf(run), () => assertGauAvailable(run.orgId));
    return { admitted: true };
  } catch (error) {
    if (error instanceof GauExhaustedError) {
      // A spent, expired or missing signup grant asks for a plan; the Free
      // row's monthly allowance, when an operator has turned the plan rule
      // off, renews (ADR-NEW, signup grant).
      return { admitted: false, reason: error.reason === "monthly_allowance_used" ? "units_exhausted" : "subscription_required" };
    }
    if (error instanceof BillingSuspendedError) return { admitted: false, reason: "suspended" };
    throw error;
  }
}

/** One governed action on the run's ledger. */
export async function meterServed(event: MeterEvent): Promise<void> {
  const { run } = event;
  await runInTenantScope(scopeOf(run), () =>
    recordGovernedActions({ orgId: run.orgId, entries: [meterEntry(event)], label: METER_LABEL }),
  );
}

/** One call to a tool into served_tool_calls, filed under the run's workspace (ADR-234). */
export async function recordServedCall(call: ServedCallRecord): Promise<void> {
  const row = servedCallRow(call);
  if (row === null) return;
  await runInTenantScope(scopeOf(call.run), () => recordServedToolCall(row));
}

let cedar: Promise<CedarRuntime | null> | undefined;

/**
 * Cedar's Node build, by a name the bundler can see. xmcp keeps the package
 * external, so the build reads its .wasm from its own directory. A build
 * that does not load serves no tool, because no policy can be decided.
 */
function loadCedar(): Promise<CedarRuntime | null> {
  cedar ??= import("@cedar-policy/cedar-wasm/nodejs").then(asCedarRuntime, () => null);
  return cedar;
}

/** Warnings from the served tools. No caller passes a secret in its fields. */
export const servedLog: ServedLog = {
  warn: (message, fields) => console.warn(message, fields ?? {}),
};

/** The ports one run's served tools use in production. */
export function createServedPorts(run: ServedRun): ServedPorts {
  return {
    off: readOffSwitches,
    // The tools discovery holds back until their sync steering PR merges.
    withheld: (served) => readWorkspaceWithheldTools(scopeOf(served)),
    admit: admitServed,
    emergencyDeny: servedEmergencyDenies(run, { gate: postgresKillSwitchReads, targets: readSwitchTargets }),
    approvals: postgresApprovals(),
    credentials: servedCredentials(run),
    transport: transportFor,
    meter: meterServed,
    recordCall: recordServedCall,
    cedar: loadCedar,
    log: servedLog,
    // The workspace's [embeddings] setting picks the index on each search.
    rank: servedRanker(scopeOf(run), searchIndexFor),
  };
}

/** The host and session a gateway key and a session header name, in Postgres. */
export const postgresRunSources: RunSources = {
  async host({ orgId, workspaceId, apiKeyId }): Promise<ServedHost | null> {
    const scope = await readKeyScope(orgId, apiKeyId);
    if (scope.kind !== "purpose" || scope.purpose !== TACHO_GATEWAY_PURPOSE) return null;
    const enrollment = scope.hostEnrollmentId;
    if (enrollment === undefined) return null;
    return runInTenantScope({ orgId, workspaceId }, () =>
      withTenantDb(async (tx): Promise<ServedHost | null> => {
        const hosts = schema.tachoHosts;
        const [host] = await tx
          .select({ id: hosts.id, publicId: hosts.publicId, runtimeId: hosts.runtimeId, enrolledBy: hosts.createdById })
          .from(hosts)
          .where(
            and(
              eq(hosts.publicId, enrollment),
              eq(hosts.orgId, orgId),
              eq(hosts.workspaceId, workspaceId),
              ne(hosts.status, "revoked"),
            ),
          )
          .limit(1);
        if (host === undefined) return null;
        // The enroller operates every session the host opens (ingest's
        // enrollingOperator). Their role is read now, not the one a session
        // stamped when it opened, so a demoted operator's runs lose the role.
        let operatorRole: string | null = null;
        if (host.enrolledBy !== null) {
          const members = schema.workspaceUsers;
          const [member] = await tx
            .select({ role: members.role })
            .from(members)
            .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, host.enrolledBy)))
            .limit(1);
          operatorRole = operatorRoleOf(member?.role);
        }
        const operator = host.enrolledBy;
        if (host.runtimeId === null) {
          return { id: host.id, publicId: host.publicId, runtime: null, operator, operatorRole };
        }
        const runtimes = schema.runtimes;
        const [runtime] = await tx
          .select({ slug: runtimes.slug })
          .from(runtimes)
          .where(
            and(
              eq(runtimes.id, host.runtimeId),
              eq(runtimes.orgId, orgId),
              eq(runtimes.workspaceId, workspaceId),
              isNull(runtimes.deletedAt),
            ),
          )
          .limit(1);
        return { id: host.id, publicId: host.publicId, runtime: runtime?.slug ?? null, operator, operatorRole };
      }),
    );
  },

  session(scope, host, sessionUuid) {
    return runInTenantScope(scope, () =>
      withTenantDb(async (tx) => {
        const sessions = schema.tachoSessions;
        const [session] = await tx
          .select({ publicId: sessions.publicId, harness: sessions.harness })
          .from(sessions)
          .where(
            and(
              eq(sessions.sessionUuid, sessionUuid),
              eq(sessions.hostId, host.id),
              eq(sessions.orgId, scope.orgId),
              eq(sessions.workspaceId, scope.workspaceId),
            ),
          )
          .limit(1);
        return session ?? null;
      }),
    );
  },
};

/** The workspace's steering connection and its published version, through the handlers' readers. */
export const postgresPublishedSources: PublishedSources = {
  connection: (scope) => runInTenantScope(scope, () => readSteeringConnection(scope)),
  current: (scope, repository) => postgresVersionStore(scope).current(repository),
};
