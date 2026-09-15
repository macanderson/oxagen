// onboarding.first_frame.get.ts — `get_first_frame` (#2967): the register
// flow's wait for the first frame, for one registered agent.
//
// The host is the live `tacho.hosts` row bound to the agent (`enroll_host`
// wrote `agent_id`); the first frame is the oldest `tacho.sessions` row from
// that host, whose public id is the run Fleet lists. `receivedAt` is the
// row's `created_at`, the server's clock when the ingest stored the session;
// `started_at` is the time the host reported and is not used here. `waitMs` is the
// handler-side long poll as on `get_run`: with no session yet, the handler
// re-reads every POLL_INTERVAL_MS inside the tenant scope until one lands or
// the budget runs out, and answers `firstFrame: null` when it does — nothing
// here completes on a timer.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import {
  onboardingFirstFrameGet,
  type OnboardingFirstFrameGetOutput,
} from "@oxagen/oxagen/contracts/onboarding.first_frame.get";
import { schema, withTenantDb } from "@oxagen/database";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { POLL_INTERVAL_MS } from "./run.get";

interface FirstFrameScope {
  orgId: string;
  workspaceId: string;
}

interface FirstFrameAgent {
  id: string;
  publicId: string;
  agentKey: string | null;
}

export interface FirstFrameHost {
  id: string;
  publicId: string;
  createdAt: Date;
  lastHeartbeatAt: Date | null;
  hooksOk: boolean | null;
}

export interface FirstFrameSession {
  publicId: string;
  /** When Oxagen stored the session (`tacho.sessions.created_at`). */
  receivedAt: Date;
}

/** The reads the handler makes, on the store or on a fake. */
export interface FirstFrameQueries {
  agent(
    scope: FirstFrameScope,
    agentPublicId: string,
  ): Promise<FirstFrameAgent | null>;
  /** The agent's live host (not revoked), oldest first when several exist. */
  host(scope: FirstFrameScope, agentId: string): Promise<FirstFrameHost | null>;
  /** The first session Oxagen stored from the host. */
  firstSession(
    scope: FirstFrameScope,
    hostId: string,
  ): Promise<FirstFrameSession | null>;
}

interface FirstFrameDeps {
  queries: FirstFrameQueries;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const postgresFirstFrameQueries: FirstFrameQueries = {
  async agent(scope, agentPublicId) {
    return withTenantDb(async (tx) => {
      const [row] = await tx
        .select({
          id: schema.agents.id,
          publicId: schema.agents.publicId,
          slug: schema.agents.slug,
          orgNamespace: schema.organizations.namespace,
          workspaceNamespace: schema.workspaces.namespace,
        })
        .from(schema.agents)
        .leftJoin(
          schema.organizations,
          eq(schema.organizations.id, schema.agents.orgId),
        )
        .leftJoin(
          schema.workspaces,
          eq(schema.workspaces.id, schema.agents.workspaceId),
        )
        .where(
          and(
            eq(schema.agents.orgId, scope.orgId),
            eq(schema.agents.workspaceId, scope.workspaceId),
            eq(schema.agents.publicId, agentPublicId),
            isNull(schema.agents.deletedAt),
          ),
        )
        .limit(1);
      if (!row) return null;
      return {
        id: row.id,
        publicId: row.publicId,
        agentKey:
          row.orgNamespace !== null && row.workspaceNamespace !== null
            ? `${row.orgNamespace}.${row.workspaceNamespace}.${row.slug}`
            : null,
      };
    });
  },
  async host(scope, agentId) {
    return withTenantDb(async (tx) => {
      const [row] = await tx
        .select({
          id: schema.tachoHosts.id,
          publicId: schema.tachoHosts.publicId,
          createdAt: schema.tachoHosts.createdAt,
          lastHeartbeatAt: schema.tachoHosts.lastHeartbeatAt,
          hooksOk: schema.tachoHosts.hooksOk,
        })
        .from(schema.tachoHosts)
        .where(
          and(
            eq(schema.tachoHosts.orgId, scope.orgId),
            eq(schema.tachoHosts.workspaceId, scope.workspaceId),
            eq(schema.tachoHosts.agentId, agentId),
            ne(schema.tachoHosts.status, "revoked"),
          ),
        )
        .orderBy(asc(schema.tachoHosts.createdAt))
        .limit(1);
      return row ?? null;
    });
  },
  async firstSession(scope, hostId) {
    return withTenantDb(async (tx) => {
      const [row] = await tx
        .select({
          publicId: schema.tachoSessions.publicId,
          receivedAt: schema.tachoSessions.createdAt,
        })
        .from(schema.tachoSessions)
        .where(
          and(
            eq(schema.tachoSessions.orgId, scope.orgId),
            eq(schema.tachoSessions.workspaceId, scope.workspaceId),
            eq(schema.tachoSessions.hostId, hostId),
          ),
        )
        .orderBy(
          asc(schema.tachoSessions.createdAt),
          asc(schema.tachoSessions.id),
        )
        .limit(1);
      return row ?? null;
    });
  },
};

export function createFirstFrameGetHandler(
  deps: FirstFrameDeps,
): CapabilityHandler<typeof onboardingFirstFrameGet> {
  return async (input, ctx): Promise<OnboardingFirstFrameGetOutput> => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const agent = await deps.queries.agent(scope, input.agentId);
    if (!agent) {
      throw new HandlerError({
        code: "not_found",
        reason: "agent_not_found",
        message: `No agent "${input.agentId}" in this workspace`,
      });
    }

    const deadline = deps.now() + input.waitMs;
    let host: FirstFrameHost | null = null;
    let session: FirstFrameSession | null = null;
    for (;;) {
      host = await deps.queries.host(scope, agent.id);
      session = host ? await deps.queries.firstSession(scope, host.id) : null;
      if (session) break;
      const remaining = deadline - deps.now();
      if (remaining <= 0) break;
      await deps.sleep(Math.min(POLL_INTERVAL_MS, remaining));
    }

    return {
      agentId: agent.publicId,
      agentKey: agent.agentKey,
      host: host
        ? {
            hostEnrollmentId: host.publicId,
            enrolledAt: host.createdAt.toISOString(),
            lastHeartbeatAt: host.lastHeartbeatAt?.toISOString() ?? null,
            hooksOk: host.hooksOk,
          }
        : null,
      firstFrame: session
        ? {
            runId: session.publicId,
            receivedAt: session.receivedAt.toISOString(),
          }
        : null,
    };
  };
}

export const onboardingFirstFrameGetHandler = createFirstFrameGetHandler({
  queries: postgresFirstFrameQueries,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
