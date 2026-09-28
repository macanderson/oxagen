// ports.ts: the production ports the served tools run on (lane M15;
// mcp-studio-spec, Call path).
//
// Each port reads or writes inside the run's tenant scope. The tests bind
// fakes to the same interfaces, so nothing here holds logic a test needs to
// reach: it reads rows, hands them on, and picks the transport the
// environment's network names.
import { assertGauAvailable, BillingSuspendedError, GauExhaustedError, recordGovernedActions } from "@oxagen/billing";
import { apiPublicOrigin } from "@oxagen/config/api-origin";
import { schema, withTenantDb } from "@oxagen/database";
import { readSteeringConnection } from "@oxagen/handlers/context.steering.host";
import { operatorRoleOf } from "@oxagen/handlers/lib/operator-role";
import { workspaceCredentialSource } from "@oxagen/handlers/mcp-studio/credentials/connect";
import { createInProcessBroker, type LocalGatewayBroker } from "@oxagen/handlers/mcp-studio/local-calls/broker";
import { postgresMachineGroupReader } from "@oxagen/handlers/mcp-studio/local-calls/groups-store";
import { launchSpecFor, machineGroupsOf } from "@oxagen/handlers/mcp-studio/local-calls/launch";
import { localCallSignerFromEnv } from "@oxagen/handlers/mcp-studio/local-calls/signer";
import { createLocalTransport } from "@oxagen/handlers/mcp-studio/local-calls/transport";
import { postgresVersionStore } from "@oxagen/handlers/steering-repo/version-store";
import { readKeyScope, TACHO_GATEWAY_PURPOSE } from "@oxagen/iam/machine-key-scope";
import { createCloudTransport, type CredentialSource, type Transport } from "@oxagen/mcp-studio";
import type { CedarRuntime } from "@oxagen/policy";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { postgresApprovals } from "./approvals";
import { unbuiltRoute } from "./call";
import { asCedarRuntime } from "./cedar";
import { lazyCredentialSource } from "./credentials";
import { METER_LABEL, meterEntry } from "./meter";
import type { PublishedSources } from "./published";
import type { RunSources, ServedHost } from "./run";
import {
  ServedRouteError,
  type Admission,
  type MeterEvent,
  type OffSwitches,
  type ServedLog,
  type ServedPorts,
  type ServedRoute,
  type ServedRun,
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
 * needs a credential. Its connect link is the API's connect route for the
 * run's workspace.
 */
export function servedCredentials(run: ServedRun): CredentialSource {
  const scope = scopeOf(run);
  return lazyCredentialSource(async () =>
    workspaceCredentialSource({ ...scope, ...(await scopeSlugs(scope)), apiBaseUrl: apiPublicOrigin() }),
  );
}

// One broker per process. A machine's local gateway long-polls this process
// for its calls. On a platform that runs each request in its own function
// instance, the gateway's poll and the agent's call can land in different
// instances, and the call reads "disconnected" until a shared broker exists.
let broker: LocalGatewayBroker | undefined;
let cloud: Transport | undefined;

function localTransport(route: ServedRoute): Transport {
  const { server, run } = route;
  const signer = localCallSignerFromEnv();
  if (signer === undefined) {
    throw new ServedRouteError(
      "local_unavailable",
      "This deployment holds no key to sign local calls, so Oxagen sent nothing. Ask an Oxagen operator to set TACHO_BUNDLE_SIGNING_KEY.",
    );
  }
  if (run.machine === null) {
    throw new ServedRouteError(
      "local_unavailable",
      "This run names no enrolled machine, so Oxagen sent nothing. Run the agent under tacho on an enrolled machine, then retry.",
    );
  }
  const { pinned } = server;
  const launch = pinned.type === "local" || pinned.type === "registry" ? launchSpecFor(server.name, pinned, server.source) : undefined;
  if (launch === undefined) {
    throw new ServedRouteError(
      "local_unavailable",
      `The lock does not say how a machine starts ${server.name}, so Oxagen sent nothing. Run tools lock in the steering repo, then open a steering PR.`,
    );
  }
  broker ??= createInProcessBroker();
  return createLocalTransport({
    scope: scopeOf(run),
    machine: run.machine,
    groups: machineGroupsOf(server.source),
    reader: postgresMachineGroupReader,
    signer,
    broker,
    launch,
  });
}

/** The transport for the network the environment names. */
export function transportFor(route: ServedRoute): Transport {
  const unbuilt = unbuiltRoute(route.network);
  if (unbuilt !== null) throw unbuilt;
  if (route.network === "local") return localTransport(route);
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
      return { admitted: false, reason: error.reason === "free_no_payment_method" ? "no_payment_method" : "units_exhausted" };
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
    // Discovery, which withholds a tool from a server, is only proposed
    // (mcp-studio-spec, Discovery). Until it stores a withheld list, none is.
    withheld: async () => new Set<string>(),
    admit: admitServed,
    approvals: postgresApprovals(),
    credentials: servedCredentials(run),
    transport: transportFor,
    meter: meterServed,
    cedar: loadCedar,
    log: servedLog,
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
