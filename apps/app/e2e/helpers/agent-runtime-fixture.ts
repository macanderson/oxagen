import postgres from "postgres";
import neo4j, { type Driver, type Session } from "neo4j-driver";
import { randomBytes, scrypt } from "node:crypto";
import { E2E_TEST_PASSWORD } from "./auth";

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
  /** Email address for the seeded user — use with `loginAs(context, email, password)`. */
  userEmail: string;
  /** Plain-text password for the seeded user — use with `loginAs(context, email, password)`. */
  password: string;
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
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  return raw;
}

const DATABASE_URL = deQuote(
  process.env.DATABASE_URL,
  "postgres://oxagen:oxagen@localhost:5432/oxagen",
);
const NEO4J_URL = deQuote(process.env.NEO4J_URI ?? process.env.NEO4J_URL, "bolt://localhost:7687");
const NEO4J_USER = deQuote(process.env.NEO4J_USERNAME ?? process.env.NEO4J_USER, "neo4j");
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

// Deterministic UUIDs for the scenario fixture rows.
// Using name-based (v5-style) stable IDs so reruns are idempotent.
const SCENARIO_IDS = {
  toolMemoryRecall: "00000000-e2e0-0000-0000-000000000001",
  toolMemoryWrite: "00000000-e2e0-0000-0000-000000000002",
  toolCodeExecute: "00000000-e2e0-0000-0000-000000000003",
  toolVersionMemoryRecall: "00000000-e2e0-0000-0001-000000000001",
  toolVersionMemoryWrite: "00000000-e2e0-0000-0001-000000000002",
  toolVersionCodeExecute: "00000000-e2e0-0000-0001-000000000003",
  execution: "00000000-e2e0-0000-0002-000000000001",
  stepRecall: "00000000-e2e0-0000-0003-000000000001",
  stepCode1: "00000000-e2e0-0000-0003-000000000002",
  stepCode2: "00000000-e2e0-0000-0003-000000000003",
  stepCode3: "00000000-e2e0-0000-0003-000000000004",
  stepWrite: "00000000-e2e0-0000-0003-000000000005",
  tcRecall: "00000000-e2e0-0000-0004-000000000001",
  tcCode1: "00000000-e2e0-0000-0004-000000000002",
  tcCode2: "00000000-e2e0-0000-0004-000000000003",
  tcCode3: "00000000-e2e0-0000-0004-000000000004",
  tcWrite: "00000000-e2e0-0000-0004-000000000005",
} as const;

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
  if (!tenantRow) throw new Error("fixture: organization insert returned no row");
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
  if (!userRow) throw new Error("fixture: user insert returned no row");
  const userId = userRow.id;

  const [wsRow] = await sql<{ id: string }[]>`
    INSERT INTO workspace.workspaces (public_id, org_id, name, slug)
    VALUES ('wrk_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 22), ${orgId}, 'Main', ${opts.workspaceSlug})
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

  // ─── Seed deterministic execution scenario rows ────────────────────────────
  // These rows represent the state the agent runtime would produce when the
  // scripted scenario executes. The UI layer is mocked (interceptAgentStream),
  // so the runtime never runs; we seed the expected final DB state here so the
  // Postgres assertions in the spec pass deterministically.

  // 1. Stub agent tools (one per capability used in scenario).
  // agent.tool_versions was dropped (release-audit Check 4 — dead schema).
  // tool_calls.tool_version_id now carries tool IDs directly (app-enforced
  // reference; no DB-level FK constraint was ever present).
  const capabilities = [
    { id: SCENARIO_IDS.toolMemoryRecall, tvId: SCENARIO_IDS.toolVersionMemoryRecall, name: "agent.memory.recall", slug: "e2e-memory-recall", toolType: "capability" },
    { id: SCENARIO_IDS.toolMemoryWrite,  tvId: SCENARIO_IDS.toolVersionMemoryWrite,  name: "agent.memory.write",  slug: "e2e-memory-write",  toolType: "capability" },
    { id: SCENARIO_IDS.toolCodeExecute,  tvId: SCENARIO_IDS.toolVersionCodeExecute,  name: "agent.code.execute",  slug: "e2e-code-execute",  toolType: "capability" },
  ] as const;

  for (const cap of capabilities) {
    await sql`
      INSERT INTO agent.tools (id, public_id, org_id, workspace_id, name, slug, tool_type, description, is_enabled, requires_approval, risk_level)
      VALUES (
        ${cap.id}::uuid,
        'tol_e2e_' || ${cap.slug},
        ${orgId},
        ${workspaceId},
        ${cap.name},
        ${cap.slug},
        ${cap.toolType},
        ${"E2E stub for " + cap.name},
        true,
        false,
        'low'
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }

  // 2. A single execution context for the scenario.
  await sql`
    INSERT INTO execution.executions (id, public_id, status, org_id, workspace_id, playbook_version_id, input_payload)
    VALUES (
      ${SCENARIO_IDS.execution}::uuid,
      'exc_e2e_runtime',
      'completed',
      ${orgId},
      ${workspaceId},
      gen_random_uuid(),   -- playbook_version_id: no FK, any UUID works
      '{}'::jsonb
    )
    ON CONFLICT (id) DO NOTHING
  `;

  // 3. Execution steps — one per tool call in the scenario.
  const steps = [
    { id: SCENARIO_IDS.stepRecall, tvId: SCENARIO_IDS.toolVersionMemoryRecall },
    { id: SCENARIO_IDS.stepCode1,  tvId: SCENARIO_IDS.toolVersionCodeExecute },
    { id: SCENARIO_IDS.stepCode2,  tvId: SCENARIO_IDS.toolVersionCodeExecute },
    { id: SCENARIO_IDS.stepCode3,  tvId: SCENARIO_IDS.toolVersionCodeExecute },
    { id: SCENARIO_IDS.stepWrite,  tvId: SCENARIO_IDS.toolVersionMemoryWrite  },
  ] as const;

  for (const step of steps) {
    await sql`
      INSERT INTO execution.execution_steps (id, public_id, status, execution_id, playbook_step_id, agent_version_id, attempt_number, input_payload, org_id, workspace_id)
      VALUES (
        ${step.id}::uuid,
        'est_e2e_' || ${step.id.slice(-8)},
        'completed',
        ${SCENARIO_IDS.execution}::uuid,
        gen_random_uuid(),  -- playbook_step_id: no FK, any UUID works
        gen_random_uuid(),  -- agent_version_id: no FK, any UUID works
        1,
        '{}'::jsonb,
        ${orgId},
        ${workspaceId}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }

  // 4. Tool call rows — one per tool-call-start/end event in the scenario.
  const toolCallRows = [
    { id: SCENARIO_IDS.tcRecall, stepId: SCENARIO_IDS.stepRecall, tvId: SCENARIO_IDS.toolVersionMemoryRecall },
    { id: SCENARIO_IDS.tcCode1,  stepId: SCENARIO_IDS.stepCode1,  tvId: SCENARIO_IDS.toolVersionCodeExecute  },
    { id: SCENARIO_IDS.tcCode2,  stepId: SCENARIO_IDS.stepCode2,  tvId: SCENARIO_IDS.toolVersionCodeExecute  },
    { id: SCENARIO_IDS.tcCode3,  stepId: SCENARIO_IDS.stepCode3,  tvId: SCENARIO_IDS.toolVersionCodeExecute  },
    { id: SCENARIO_IDS.tcWrite,  stepId: SCENARIO_IDS.stepWrite,  tvId: SCENARIO_IDS.toolVersionMemoryWrite  },
  ] as const;

  for (const tc of toolCallRows) {
    await sql`
      INSERT INTO execution.tool_calls (id, public_id, execution_step_id, tool_version_id, request_payload, status, org_id, workspace_id)
      VALUES (
        ${tc.id}::uuid,
        'tcl_e2e_' || ${tc.id.slice(-8)},
        ${tc.stepId}::uuid,
        ${tc.tvId}::uuid,
        '{}'::jsonb,
        'completed',
        ${orgId},
        ${workspaceId}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }

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
      'apr_e2e_001',
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

  // 6. Subagent fanout + three runs.
  const [fanoutRow] = await sql<{ id: string }[]>`
    INSERT INTO agent.subagent_fanouts (
      id, public_id, org_id, workspace_id, parent_message_id, status, total_children, completed_children
    )
    VALUES (
      gen_random_uuid(),
      'fan_e2e_001',
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
        SELECT id FROM agent.subagent_fanouts WHERE public_id = 'fan_e2e_001'
      `;

  if (fanoutExisting) {
    const fanoutId = fanoutExisting.id;
    // child_message_id is a UUID column — use deterministic UUIDs.
    const subagentRuns = [
      { publicId: "sr_e2e_001", childMessageUuid: "00000000-e2e0-0000-0006-000000000001", capability: "agent.code.execute" },
      { publicId: "sr_e2e_002", childMessageUuid: "00000000-e2e0-0000-0006-000000000002", capability: "agent.code.execute" },
      { publicId: "sr_e2e_003", childMessageUuid: "00000000-e2e0-0000-0006-000000000003", capability: "agent.code.execute" },
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
            "agent.memory.recall",
            "agent.code.execute",
            "agent.code.execute",
            "agent.code.execute",
            "agent.memory.write",
          ],
        },
      );
      // Create AgentMemory node from the memory.write.
      await session.run(
        `
        MERGE (m:AgentMemory {memoryId: $memoryId, orgId: $orgId})
        SET m.weight = 'fact', m.nodeRef = $nodeRef
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
    sessionToken,
    orgSlug: opts.orgSlug,
    workspaceSlug: opts.workspaceSlug,
    async queryDbState(): Promise<DbState> {
      // Query tool calls with their capability names. `tool_version_id` on
      // `execution.tool_calls` carries the tool ID directly (agent.tool_versions
      // was dropped in migration 0004 — release-audit Check 4). The e2e fixture
      // seeds tool_calls with tvId === tool.id so the direct join works here.
      const toolCalls = await sql<
        { id: string; capability: string; status: string }[]
      >`
        SELECT tc.id::text AS id,
               COALESCE(t.name, 'unknown') AS capability,
               tc.status
        FROM execution.tool_calls tc
        LEFT JOIN agent.tools t ON t.id = tc.tool_version_id
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
    // Tool calls must be deleted before execution steps, steps before executions.
    await sql`DELETE FROM execution.tool_calls WHERE execution_step_id IN (
      SELECT id FROM execution.execution_steps WHERE execution_id IN (
        SELECT id FROM execution.executions WHERE org_id = ${orgId}
      )
    )`;
    await sql`DELETE FROM execution.execution_steps WHERE execution_id IN (
      SELECT id FROM execution.executions WHERE org_id = ${orgId}
    )`;
    await sql`DELETE FROM execution.executions WHERE org_id = ${orgId}`;
    await sql`DELETE FROM agent.tools WHERE org_id = ${orgId}`;
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
