import postgres from "postgres";
import neo4j, { type Driver, type Session } from "neo4j-driver";

// Test fixture for the agent runtime E2E. Manages a deterministic tenant +
// workspace + user + auth session, plus the execution/approval/fanout rows
// that the scripted scenario (`scriptedScenarioEvents`) would produce if the
// full agent runtime were running. All inserts are idempotent via ON CONFLICT
// DO NOTHING so reruns don't fail on leftover state from a previous aborted
// run.

export interface FixtureOptions {
  orgSlug: string;
  workspaceSlug: string;
  userEmail: string;
  /**
   * When true, seed the IAM rows (role + the user's principal + role
   * assignment + role_grants) that the IAM-enforced API surface (:4000)
   * requires. Opt-in because most fixtures drive the APP surface, where
   * invoke() does not enforce IAM. Raw SQL mirror of bootstrapOrgIAM — the
   * fixture stays dependency-free (no @oxagen/handlers import in the
   * Playwright process). Grants cover IAM_E2E_GRANTS; extend that list when
   * a new API-surface spec exercises another deny-by-default capability.
   */
  bootstrapIam?: boolean;
  /**
   * Persona for the seeded IAM rows (default "org-owner"):
   *  - "org-owner": org-scope Owner role with an ORG-WIDE assignment
   *    (workspace_id NULL). Matches real org owners — passes handler-level
   *    gates that demand an org Owner/Admin (api.key.create/revoke) and can
   *    reach every workspace in the org.
   *  - "workspace-owner": workspace-scope Owner role with a WORKSPACE-SCOPED
   *    assignment. Matches plain workspace members — IAM denies them outside
   *    their own workspace, which is what isolation specs assert.
   */
  iamRole?: "org-owner" | "workspace-owner";
}

// Capabilities granted to the seeded Owner role when bootstrapIam is true.
// Union of every defaultEffect:"deny" capability the API-surface e2e specs
// call (api-key-lifecycle, workspace-isolation).
const IAM_E2E_GRANTS = [
  "list_conversations",
  "create_api_key",
  "revoke_api_key",
] as const;

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
  userEmail: string;
  sessionToken: string;
  orgSlug: string;
  workspaceSlug: string;
  queryDbState(): Promise<DbState>;
  queryNeo4jState(): Promise<Neo4jState>;
  close(): Promise<void>;
}

// Strip one balanced surrounding double-quote pair that Vercel dev tooling
// adds (e.g. `KEY="value"` in .env). This matches the normalizeEnv logic in
// packages/config/src/env.ts so fixture env reads stay consistent with the
// running app.
function deQuote(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))
    return raw.slice(1, -1);
  return raw;
}

const DATABASE_URL = deQuote(
  process.env.DATABASE_URL,
  "postgres://oxagen:oxagen@localhost:5433/oxagen",
);
const NEO4J_URL = deQuote(
  process.env.NEO4J_URI ?? process.env.NEO4J_URL,
  "bolt://localhost:7687",
);
const NEO4J_USER = deQuote(
  process.env.NEO4J_USERNAME ?? process.env.NEO4J_USER,
  "neo4j",
);
const NEO4J_PASSWORD = deQuote(process.env.NEO4J_PASSWORD, "oxagen-dev");

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
    INSERT INTO org.organizations (public_id, name, slug, namespace, plan_type, status)
    VALUES (
      'org_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 22),
      ${"E2E " + opts.orgSlug},
      ${opts.orgSlug},
      -- namespace is NOT NULL + immutable (added by the namespace-identity
      -- migration) and must match ^[a-z0-9]{2,6}$. A random 6-hex handle keeps
      -- parallel-shard fixtures globally unique without a taken-set lookup.
      substr(md5(gen_random_uuid()::text), 1, 6),
      'free',
      'active'
    )
    ON CONFLICT (slug) DO UPDATE SET status = 'active'
    RETURNING id
  `;
  if (!tenantRow)
    throw new Error("fixture: organization insert returned no row");
  const orgId = tenantRow.id;
  // Per-fixture suffix for every seeded public_id. CI runs e2e shards in
  // PARALLEL against one database, so hardcoded global public_ids let two specs
  // collide on the UNIQUE(public_id) constraints; the ON CONFLICT loser then
  // referenced / was cleaned up against the winner's rows → FK violations and
  // cascading session-token dups. Deriving the suffix from the org's id keeps
  // every fixture's rows isolated.
  const sfx = orgId.replace(/-/g, "").slice(0, 16);

  const [userRow] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (public_id, email, display_name, status)
    VALUES (
      'usr_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 22),
      ${opts.userEmail},
      'E2E Runtime',
      'active'
    )
    ON CONFLICT (email) DO UPDATE SET status = 'active'
    RETURNING id
  `;
  if (!userRow) throw new Error("fixture: user insert returned no row");
  const userId = userRow.id;

  const [wsRow] = await sql<{ id: string }[]>`
    INSERT INTO workspace.workspaces (public_id, org_id, name, slug, namespace)
    VALUES ('wrk_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 22), ${orgId}, 'Main', ${opts.workspaceSlug}, substr(md5(gen_random_uuid()::text), 1, 6))
    ON CONFLICT (org_id, slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  if (!wsRow) throw new Error("fixture: workspace insert returned no row");
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

  // OXA-1498: seed IAM so the user is an authorized principal on the
  // IAM-enforced API surface. The resolver (rule 7) matches role_grants by
  // exact capability string from the principal's assigned roles; without
  // these rows every defaultEffect:"deny" capability 403s. Idempotent —
  // public_ids are deterministic per org/user, so reruns and the second
  // fixture of a shared org hit ON CONFLICT.
  if (opts.bootstrapIam) {
    // Per-user suffix: two fixtures can share one org (same sfx), so
    // principal/assignment rows must key off the user, not the org.
    const userSfx = userId.replace(/-/g, "").slice(0, 16);
    const persona = opts.iamRole ?? "org-owner";
    const roleScope = persona === "org-owner" ? "org" : "workspace";
    // Org-wide assignment (NULL workspace_id) for org owners — handler-level
    // gates (api.key.create/revoke resolveActorRole) require exactly that.
    // Workspace-scoped assignment for workspace owners — fetch-authz only
    // surfaces it when ctx.workspaceId matches, so cross-workspace requests
    // fall through to defaultEffect deny (the isolation specs' premise).
    const assignmentWorkspaceId = persona === "org-owner" ? null : workspaceId;

    const rolePublicId = `rol_e2e_${sfx}_${roleScope}`;
    const [roleRow] = await sql<{ id: string }[]>`
      INSERT INTO iam.roles (public_id, org_id, scope_kind, name, is_system_default)
      VALUES (${rolePublicId}, ${orgId}, ${roleScope}, 'Owner', true)
      ON CONFLICT (public_id) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `;
    if (!roleRow) throw new Error("fixture: IAM role upsert returned no row");
    const roleId = roleRow.id;

    const [principalRow] = await sql<{ id: string }[]>`
      INSERT INTO iam.principals (public_id, org_id, kind, display_name, status, parent_user_id)
      VALUES (${`prn_e2e_${userSfx}`}, ${orgId}, 'human', 'E2E Runtime', 'active', ${userId})
      ON CONFLICT (public_id) DO UPDATE SET status = 'active'
      RETURNING id
    `;
    if (!principalRow)
      throw new Error("fixture: IAM principal upsert returned no row");

    await sql`
      INSERT INTO iam.principal_role_assignments (public_id, principal_id, role_id, org_id, workspace_id, assigned_by)
      VALUES (${`pra_e2e_${userSfx}`}, ${principalRow.id}, ${roleId}, ${orgId}, ${assignmentWorkspaceId}, ${userId})
      ON CONFLICT (public_id) DO NOTHING
    `;

    for (const capability of IAM_E2E_GRANTS) {
      await sql`
        INSERT INTO iam.role_grants (public_id, org_id, role_id, capability_id, effect)
        VALUES (${`rlg_e2e_${sfx}_${roleScope}_${capability}`}, ${orgId}, ${roleId}, ${capability}, 'allow')
        ON CONFLICT (public_id) DO NOTHING
      `;
    }
  }

  // Better Auth session row — used by the auth helper to inject a logged-in
  // cookie without going through OAuth.
  // Include the workspaceId in the session token to make it unique even when
  // two fixtures share the same orgId (same org, different workspaces) and
  // run in parallel via Promise.all within the same millisecond.
  const sessionToken = `e2e-session-${orgId}-${workspaceId}-${Date.now()}`;
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

  // ─── Seed deterministic execution scenario rows ────────────────────────────
  // agent.tools, execution.executions, execution.execution_steps, and
  // execution.tool_calls were all dropped (migrations 0020–0021). Tool-call
  // tracking now lives in ClickHouse telemetry. Only approval_requests,
  // subagent_fanouts, and subagent_runs still live in Postgres and are seeded.

  // 5. Approval request — mirrors the `approval-required` scripted event.
  // The `message_id` column is a UUID; we use a deterministic UUID derived
  // from the scenario's `parentMessageId` = "msg_root".
  const msgRootUuid = "00000000-e2e0-0000-0005-000000000001";
  await sql`
    INSERT INTO agent.approval_requests (
      id, public_id, org_id, workspace_id, message_id,
      capability_name, input_preview, risk_level, resolution, resolved_at, expires_at
    )
    VALUES (
      gen_random_uuid(),
      ${`apr_e2e_${sfx}`},
      ${orgId},
      ${workspaceId},
      ${msgRootUuid}::uuid,
      'agent.plan',
      '{"planId":"pln_001"}'::jsonb,
      'high',
      'approved',
      now(),
      now() + interval '5 minutes'
    )
    ON CONFLICT (public_id) DO NOTHING
  `;

  // 6. Subagent fanout + three runs (public_ids suffixed via `sfx`, see above).
  const fanoutPublicId = `fan_e2e_${sfx}`;
  const [fanoutRow] = await sql<{ id: string }[]>`
    INSERT INTO agent.subagent_fanouts (
      id, public_id, org_id, workspace_id, parent_message_id, status, total_children, completed_children
    )
    VALUES (
      gen_random_uuid(),
      ${fanoutPublicId},
      ${orgId},
      ${workspaceId},
      ${msgRootUuid}::uuid,
      'completed',
      3,
      3
    )
    ON CONFLICT (public_id) DO NOTHING
    RETURNING id
  `;

  // `fanoutRow` may be null if the row already existed (ON CONFLICT DO NOTHING).
  // Re-fetch if needed.
  const [fanoutExisting] = fanoutRow
    ? [fanoutRow]
    : await sql<{ id: string }[]>`
        SELECT id FROM agent.subagent_fanouts WHERE public_id = ${fanoutPublicId}
      `;

  if (fanoutExisting) {
    const fanoutId = fanoutExisting.id;
    // child_message_id is a UUID column — use deterministic UUIDs.
    const subagentRuns = [
      {
        publicId: `sr_e2e_${sfx}_001`,
        childMessageUuid: "00000000-e2e0-0000-0006-000000000001",
        capability: "execute_code",
      },
      {
        publicId: `sr_e2e_${sfx}_002`,
        childMessageUuid: "00000000-e2e0-0000-0006-000000000002",
        capability: "execute_code",
      },
      {
        publicId: `sr_e2e_${sfx}_003`,
        childMessageUuid: "00000000-e2e0-0000-0006-000000000003",
        capability: "execute_code",
      },
    ];
    for (const run of subagentRuns) {
      await sql`
        INSERT INTO agent.subagent_runs (
          id, public_id, fanout_id, child_message_id, capability_name,
          input_payload, status, org_id, workspace_id
        )
        VALUES (
          gen_random_uuid(),
          ${run.publicId},
          ${fanoutId}::uuid,
          ${run.childMessageUuid}::uuid,
          ${run.capability},
          '{}'::jsonb,
          'completed',
          ${orgId},
          ${workspaceId}
        )
        ON CONFLICT (public_id) DO NOTHING
      `;
    }
  }

  // ─── Seed Neo4j scenario nodes ─────────────────────────────────────────────
  // INVOKED edges from the 5 tool calls + 1 AgentMemory node from the write.
  try {
    const driver = getNeo();
    const session: Session = driver.session();
    try {
      // Create INVOKED edges: one per tool call in the scenario.
      // We use CREATE (not MERGE) so each tool call produces a distinct edge
      // even when the same capability is called multiple times (e.g. three
      // agent.code.execute calls). The spec asserts invokedEdges >= 5.
      await session.run(
        `
        MERGE (a:AgentRun {orgId: $orgId, runId: $runId})
        WITH a
        UNWIND $caps AS cap
        MERGE (b:Capability {name: cap, orgId: $orgId})
        CREATE (a)-[:INVOKED {orgId: $orgId}]->(b)
        `,
        {
          orgId,
          runId: `e2e-run-${orgId}`,
          caps: [
            "recall_memory",
            "execute_code",
            "execute_code",
            "execute_code",
            "write_memory",
          ],
        },
      );
      // Create AgentMemory node from the memory.write, on the two-axis model
      // (memoryClass/confidenceScore/enforcementScore/status — see
      // docs/specs/two-axis-memory/DESIGN.md). This fixture only needs to
      // produce a countable node for the tenant/workspace-isolation specs, not
      // a fully rendered Knowledge → Memories row.
      await session.run(
        `
        MERGE (m:AgentMemory {memoryId: $memoryId, orgId: $orgId})
        SET m.memoryClass = 'FACT',
            m.confidenceScore = 100,
            m.enforcementScore = 100,
            m.status = 'ACTIVE',
            m.nodeRef = $nodeRef
        `,
        { orgId, memoryId: "mem_new", nodeRef: "AgentMemory:mem_new" },
      );
    } finally {
      await session.close();
    }
  } catch {
    // Neo4j may not be reachable in some local dev configs; tolerate.
  }

  const fixture: AgentRuntimeFixture = {
    orgId,
    workspaceId,
    userId,
    userEmail: opts.userEmail,
    sessionToken,
    orgSlug: opts.orgSlug,
    workspaceSlug: opts.workspaceSlug,
    async queryDbState(): Promise<DbState> {
      // execution.tool_calls and agent.tools were dropped (migrations 0020–0021).
      // Tool-call tracking is now in ClickHouse telemetry.
      const toolCalls: Array<{
        id: string;
        capability: string;
        status: string;
      }> = [];
      const byCap: Record<string, number> = {};

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
    // execution.* and agent.tools were dropped (migrations 0020–0021).
    await sql`DELETE FROM agent.subagent_runs WHERE fanout_id IN (
      SELECT id FROM agent.subagent_fanouts WHERE org_id = ${orgId}
    )`;
    await sql`DELETE FROM agent.subagent_fanouts WHERE org_id = ${orgId}`;
    await sql`DELETE FROM agent.approval_requests WHERE org_id = ${orgId}`;
    // IAM rows seeded when FixtureOptions.bootstrapIam was set. They reference
    // the org and its users, so delete them in FK-safe order BEFORE the
    // org/user rows or org deletion hits a FK violation:
    // assignments → role_grants → principals → roles
    //   principal_role_assignments.principal_id → iam.principals
    //   principal_role_assignments.role_id      → iam.roles
    //   role_grants.role_id                     → iam.roles
    // Safe no-op when bootstrapIam was not used (deletes 0 rows).
    await sql`DELETE FROM iam.principal_role_assignments WHERE org_id = ${orgId}`;
    await sql`DELETE FROM iam.role_grants WHERE role_id IN (SELECT id FROM iam.roles WHERE org_id = ${orgId})`;
    await sql`DELETE FROM iam.principals WHERE org_id = ${orgId}`;
    await sql`DELETE FROM iam.roles WHERE org_id = ${orgId}`;
    // Collect user IDs BEFORE deleting org_users (needed for session + auth.user cleanup).
    const orgUserRows = await sql<{ userId: string }[]>`
      SELECT user_id::text AS "userId" FROM org.org_users WHERE org_id = ${orgId}
    `;
    const orgUserIds = orgUserRows.map((r) => r.userId);

    // Delete auth.sessions for these users BEFORE deleting org_users.
    if (orgUserIds.length > 0) {
      await sql`DELETE FROM auth.sessions WHERE user_id = ANY(${orgUserIds}::uuid[])`;
    }
    await sql`DELETE FROM workspace.workspace_users WHERE workspace_id IN (
      SELECT id FROM workspace.workspaces WHERE org_id = ${orgId}
    )`;
    await sql`DELETE FROM workspace.workspaces WHERE org_id = ${orgId}`;
    await sql`DELETE FROM org.org_users WHERE org_id = ${orgId}`;
    // Delete auth.users — sessions already deleted above, org_users already deleted.
    if (orgUserIds.length > 0) {
      await sql`DELETE FROM auth.users WHERE id = ANY(${orgUserIds}::uuid[])`;
    }
    await sql`DELETE FROM org.organizations WHERE id = ${orgId}`;

    // Best-effort Neo4j cleanup.
    try {
      const driver = getNeo();
      const session = driver.session();
      try {
        await session.run(`MATCH (n) WHERE n.orgId = $orgId DETACH DELETE n`, {
          orgId,
        });
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
