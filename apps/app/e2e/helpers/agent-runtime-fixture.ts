import postgres from "postgres";
import neo4j, { type Driver, type Session } from "neo4j-driver";

// Test fixture for the agent runtime E2E. Manages a deterministic tenant +
// workspace + user + auth session, plus accessors for the Postgres rows and
// Neo4j edges the scripted scenario is expected to produce. All inserts are
// idempotent via ON CONFLICT DO NOTHING so reruns don't fail on leftover
// state from a previous aborted run.

export interface FixtureOptions {
  orgSlug: string;
  workspaceSlug: string;
  userEmail: string;
}

export interface DbState {
  toolCalls: Array<{ id: string; capability: string; status: string }>;
  toolCallsByCapability: Record<string, number>;
  approvalRequests: Array<{ id: string; resolution: string | null }>;
  subagentFanouts: Array<{ id: string; status: string; totalChildren: number }>;
  subagentRuns: Array<{ id: string; status: string; capability: string }>;
}

export interface Neo4jState {
  invokedEdges: number;
  agentMemoryNodes: number;
}

export interface AgentRuntimeFixture {
  orgId: string;
  workspaceId: string;
  userId: string;
  sessionToken: string;
  orgSlug: string;
  workspaceSlug: string;
  queryDbState(): Promise<DbState>;
  queryNeo4jState(): Promise<Neo4jState>;
  close(): Promise<void>;
}

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://oxagen:oxagen@localhost:5432/oxagen";
const NEO4J_URL = process.env.NEO4J_URL ?? "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER ?? "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? "oxagen-dev";

let pg: ReturnType<typeof postgres> | null = null;
let neoDriver: Driver | null = null;

function getPg(): ReturnType<typeof postgres> {
  if (!pg) pg = postgres(DATABASE_URL, { max: 3, prepare: false });
  return pg;
}

function getNeo(): Driver {
  if (!neoDriver) {
    neoDriver = neo4j.driver(
      NEO4J_URL,
      neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
    );
  }
  return neoDriver;
}

export async function setupAgentRuntimeFixture(
  opts: FixtureOptions,
): Promise<AgentRuntimeFixture> {
  const sql = getPg();

  const [tenantRow] = await sql<{ id: string }[]>`
    INSERT INTO org.organizations (public_id, name, slug, plan_type, status)
    VALUES (
      'org_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 22),
      ${"E2E " + opts.orgSlug},
      ${opts.orgSlug},
      'free',
      'active'
    )
    ON CONFLICT (slug) DO UPDATE SET status = 'active'
    RETURNING id
  `;
  const orgId = tenantRow.id;

  const [userRow] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (public_id, email, display_name, status, email_verified_at)
    VALUES (
      'usr_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 22),
      ${opts.userEmail},
      'E2E Runtime',
      'active',
      now()
    )
    ON CONFLICT (email) DO UPDATE SET status = 'active'
    RETURNING id
  `;
  const userId = userRow.id;

  const [wsRow] = await sql<{ id: string }[]>`
    INSERT INTO workspace.workspaces (public_id, org_id, name, slug)
    VALUES ('wrk_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 22), ${orgId}, 'Main', ${opts.workspaceSlug})
    ON CONFLICT (org_id, slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  const workspaceId = wsRow.id;

  await sql`
    INSERT INTO org.org_users (public_id, org_id, user_id, role, joined_at)
    VALUES ('oru_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 22), ${orgId}, ${userId}, 'owner', now())
    ON CONFLICT (org_id, user_id) DO NOTHING
  `;
  await sql`
    INSERT INTO workspace.workspace_users (public_id, workspace_id, user_id, role, joined_at)
    VALUES ('wsu_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 22), ${workspaceId}, ${userId}, 'owner', now())
    ON CONFLICT (workspace_id, user_id) DO NOTHING
  `;

  // Better Auth session row — used by the auth helper to inject a logged-in
  // cookie without going through OAuth.
  const sessionToken = `e2e-session-${orgId}-${Date.now()}`;
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await sql`
    INSERT INTO auth.sessions (id, token, user_id, expires_at, ip_address, user_agent)
    VALUES (
      ${sessionToken},
      ${sessionToken},
      ${userId},
      ${expiresAt},
      '127.0.0.1',
      'playwright-e2e'
    )
    ON CONFLICT (id) DO NOTHING
  `;

  const fixture: AgentRuntimeFixture = {
    orgId,
    workspaceId,
    userId,
    sessionToken,
    orgSlug: opts.orgSlug,
    workspaceSlug: opts.workspaceSlug,
    async queryDbState(): Promise<DbState> {
      const toolCalls = await sql<
        { id: string; capability: string; status: string }[]
      >`
        SELECT tc.id::text AS id,
               COALESCE(tv.name, 'unknown') AS capability,
               tc.status
        FROM execution.tool_calls tc
        LEFT JOIN execution.tool_versions tv ON tv.id = tc.tool_version_id
        WHERE tc.created_at > now() - interval '10 minutes'
      `;
      const byCap: Record<string, number> = {};
      for (const r of toolCalls) {
        byCap[r.capability] = (byCap[r.capability] ?? 0) + 1;
      }

      const approvalRequests = await sql<
        { id: string; resolution: string | null }[]
      >`
        SELECT id::text AS id, resolution
        FROM agent.approval_requests
        WHERE org_id = ${orgId}
      `;
      const subagentFanouts = await sql<
        { id: string; status: string; totalChildren: number }[]
      >`
        SELECT id::text AS id, status, total_children AS "totalChildren"
        FROM agent.subagent_fanouts
        WHERE org_id = ${orgId}
      `;
      const subagentRuns = await sql<
        { id: string; status: string; capability: string }[]
      >`
        SELECT sr.id::text AS id,
               sr.status,
               sr.capability_name AS capability
        FROM agent.subagent_runs sr
        JOIN agent.subagent_fanouts f ON f.id = sr.fanout_id
        WHERE f.org_id = ${orgId}
      `;
      return {
        toolCalls,
        toolCallsByCapability: byCap,
        approvalRequests,
        subagentFanouts,
        subagentRuns,
      };
    },
    async queryNeo4jState(): Promise<Neo4jState> {
      const driver = getNeo();
      const session: Session = driver.session();
      try {
        const invoked = await session.run(
          `MATCH (a)-[r:INVOKED]->(b)
           WHERE r.orgId = $orgId
           RETURN count(r) AS c`,
          { orgId },
        );
        const mem = await session.run(
          `MATCH (m:AgentMemory) WHERE m.orgId = $orgId RETURN count(m) AS c`,
          { orgId },
        );
        return {
          invokedEdges: Number(invoked.records[0]?.get("c") ?? 0),
          agentMemoryNodes: Number(mem.records[0]?.get("c") ?? 0),
        };
      } finally {
        await session.close();
      }
    },
    async close(): Promise<void> {
      // Per-fixture close is a no-op; the shared pool is torn down by
      // `teardownFixture`.
    },
  };

  return fixture;
}

export async function teardownFixture(opts: {
  orgSlug: string;
}): Promise<void> {
  const sql = getPg();
  const [t] = await sql<{ id: string }[]>`
    SELECT id::text AS id
    FROM org.organizations
    WHERE slug = ${opts.orgSlug}
  `;
  if (t) {
    const orgId = t.id;
    // Order matters where FKs are app-enforced rather than DB-enforced.
    await sql`DELETE FROM agent.subagent_runs WHERE fanout_id IN (
      SELECT id FROM agent.subagent_fanouts WHERE org_id = ${orgId}
    )`;
    await sql`DELETE FROM agent.subagent_fanouts WHERE org_id = ${orgId}`;
    await sql`DELETE FROM agent.approval_requests WHERE org_id = ${orgId}`;
    await sql`DELETE FROM workspace.workspace_users WHERE workspace_id IN (
      SELECT id FROM workspace.workspaces WHERE org_id = ${orgId}
    )`;
    await sql`DELETE FROM workspace.workspaces WHERE org_id = ${orgId}`;
    await sql`DELETE FROM org.org_users WHERE org_id = ${orgId}`;
    await sql`DELETE FROM org.organizations WHERE id = ${orgId}`;

    // Best-effort Neo4j cleanup.
    try {
      const driver = getNeo();
      const session = driver.session();
      try {
        await session.run(
          `MATCH (n) WHERE n.orgId = $orgId DETACH DELETE n`,
          { orgId },
        );
      } finally {
        await session.close();
      }
    } catch {
      // Neo4j may not be reachable in some local dev configs; tolerate.
    }
  }

  await sql.end({ timeout: 5 });
  pg = null;
  if (neoDriver) {
    await neoDriver.close();
    neoDriver = null;
  }
}
