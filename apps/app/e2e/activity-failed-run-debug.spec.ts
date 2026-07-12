/**
 * activity-failed-run-debug — e2e spec proving the two runtime gaps flagged
 * against apps/app/capability-ui-map.json:
 *   1. debug_execution: a FAILED run renders the structured failure frame
 *      (data-testid="run-debug-panel") ABOVE the span tree.
 *   2. get_execution_lineage: a populated `(:Execution)-[:TOUCHED_FILE]->
 *      (:SourceFile)` graph renders on the run-detail lineage section.
 *
 * Seeding mirrors agent-trace-get.spec.ts exactly for Postgres (raw INSERTs
 * against agent.agent_executions/agent_execution_steps/agent_tool_calls,
 * ON CONFLICT idempotent) but with status='failed' + a failure_reason shaped
 * like a real JS error ("TypeError: …") so agent.debug.trace's deterministic
 * classFromFailureReason() extracts a non-null errorClass WITHOUT needing any
 * ClickHouse error_events/logs seeding — Postgres-only seeding is sufficient
 * proof per the failure-frame contract (agent.debug.trace renders even with
 * empty errorEvents/logsSample).
 *
 * Neo4j seeding mirrors the connection convention already established in
 * helpers/agent-runtime-fixture.ts (same env vars, same neo4j-driver client,
 * best-effort — the fixture's own teardownFixture() already DETACH DELETEs
 * every node tagged with this org's orgId, including the ones seeded here, so
 * no separate Neo4j cleanup is needed).
 *
 * Screenshots go to apps/app/e2e/screenshots/ (gitignored).
 */
import { test, expect } from "@playwright/test";
import postgres from "postgres";
import neo4j, { type Driver, type Session } from "neo4j-driver";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loginWithSession } from "./helpers/auth";
import {
  setupAgentRuntimeFixture,
  teardownFixture,
  type AgentRuntimeFixture,
} from "./helpers/agent-runtime-fixture";

const SCREENSHOT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "screenshots",
);

function deQuote(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1);
  }
  return raw;
}
const DATABASE_URL = deQuote(
  process.env.DATABASE_URL,
  "postgres://oxagen:oxagen@localhost:5432/oxagen",
);
// Same env-var resolution + defaults as helpers/agent-runtime-fixture.ts, kept
// local to this spec so it stays a self-contained, standalone e2e client (the
// fixture module doesn't expose its internal driver for external seeding).
const NEO4J_URL = deQuote(process.env.NEO4J_URI ?? process.env.NEO4J_URL, "bolt://localhost:7687");
const NEO4J_USER = deQuote(process.env.NEO4J_USERNAME ?? process.env.NEO4J_USER, "neo4j");
const NEO4J_PASSWORD = deQuote(process.env.NEO4J_PASSWORD, "oxagen-dev");

const ORG_SLUG = "e2e-debug-run";
const WS_SLUG = "main";
const USER_EMAIL = "e2e+debugrun@oxagen.ai";

const FAILURE_REASON =
  "TypeError: Cannot read properties of undefined (reading 'id')";
const FILE_NATURAL_KEY = "packages/ontology/src/resolve.ts";
const FILE_DISPLAY_NAME = "resolve.ts";

let fixture: AgentRuntimeFixture;
let execPublicId: string;

test.describe("failed run — Debug panel + populated lineage", () => {
  test.beforeAll(async () => {
    fixture = await setupAgentRuntimeFixture({
      orgSlug: ORG_SLUG,
      workspaceSlug: WS_SLUG,
      userEmail: USER_EMAIL,
    });

    const sfx = fixture.orgId.replace(/-/g, "").slice(0, 16);
    execPublicId = `aex_e2edbg_${sfx}`;
    const stepPublicId = `aes_e2edbg_${sfx}`;
    const toolPublicId = `atc_e2edbg_${sfx}`;

    // ── 1. Postgres: a FAILED execution → failed step → failed tool call. ──
    const sql = postgres(DATABASE_URL, { max: 2, prepare: false });
    try {
      const [exec] = await sql<{ id: string }[]>`
        INSERT INTO agent.agent_executions (
          id, public_id, org_id, workspace_id, origin_type, origin_id, status,
          input_payload, output_payload, failure_reason, started_at, completed_at,
          latency_ms, input_tokens, output_tokens, estimated_cost_usd
        )
        VALUES (
          gen_random_uuid(), ${execPublicId}, ${fixture.orgId}, ${fixture.workspaceId},
          'chat', gen_random_uuid(), 'failed',
          '{"prompt":"e2e failing run"}'::jsonb, NULL, ${FAILURE_REASON},
          now() - interval '4 seconds', now(), 4000, 120, 60, 0.012000
        )
        ON CONFLICT (public_id) DO UPDATE
          SET status = 'failed', failure_reason = EXCLUDED.failure_reason
        RETURNING id
      `;
      const executionId = exec!.id;

      const [step] = await sql<{ id: string }[]>`
        INSERT INTO agent.agent_execution_steps (
          id, public_id, execution_id, org_id, workspace_id, step_number,
          step_type, status, input_payload, failure_reason, latency_ms,
          input_tokens, output_tokens, started_at, completed_at
        )
        VALUES (
          gen_random_uuid(), ${stepPublicId}, ${executionId}, ${fixture.orgId}, ${fixture.workspaceId}, 1,
          'tool_call', 'failed', '{}'::jsonb, ${FAILURE_REASON}, 1000, 10, 5,
          now() - interval '3 seconds', now() - interval '2 seconds'
        )
        ON CONFLICT (public_id) DO UPDATE
          SET status = 'failed', failure_reason = EXCLUDED.failure_reason
        RETURNING id
      `;
      const stepId = step!.id;

      await sql`
        INSERT INTO agent.agent_tool_calls (
          id, public_id, execution_step_id, org_id, workspace_id, tool_name,
          tool_type, request_payload, response_payload, status, latency_ms,
          input_tokens, output_tokens
        )
        VALUES (
          gen_random_uuid(), ${toolPublicId}, ${stepId}, ${fixture.orgId}, ${fixture.workspaceId},
          'get_ontology_neighbors', 'capability', '{"nodeId":"n1"}'::jsonb,
          NULL, 'failed', 800, 4, 2
        )
        ON CONFLICT (public_id) DO UPDATE SET status = 'failed'
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }

    // ── 2. Neo4j: (:Execution)-[:TOUCHED_FILE]->(:SourceFile) for the SAME
    //    execution, matched by the handler on `e.publicId = $executionId`
    //    within {orgId, workspaceId} (packages/agent/src/memory/neo4j.ts
    //    getExecutionLineage). Best-effort — tolerate Neo4j being unreachable
    //    in some local dev configs, same as the fixture itself. ──
    try {
      const driver: Driver = neo4j.driver(
        NEO4J_URL,
        neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
      );
      const session: Session = driver.session();
      try {
        await session.run(
          `
          MERGE (e:Execution {orgId: $orgId, workspaceId: $workspaceId, publicId: $execPublicId})
          SET e.id = $execPublicId,
              e.label = 'Execution',
              e.displayName = $execDisplayName,
              e.status = 'failed',
              e.originType = 'chat',
              e.properties = '{}'
          MERGE (f:SourceFile {orgId: $orgId, naturalKey: $fileNaturalKey})
          SET f.path = $fileNaturalKey,
              f.displayName = $fileDisplayName
          MERGE (e)-[:TOUCHED_FILE]->(f)
          `,
          {
            orgId: fixture.orgId,
            workspaceId: fixture.workspaceId,
            execPublicId,
            execDisplayName: "chat execution",
            fileNaturalKey: FILE_NATURAL_KEY,
            fileDisplayName: FILE_DISPLAY_NAME,
          },
        );
      } finally {
        await session.close();
        await driver.close();
      }
    } catch {
      // Neo4j unreachable — the lineage assertions below will fail loudly
      // instead (no silent pass), same tolerance policy as the fixture.
    }

    fs.rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  test.afterAll(async () => {
    const sql = postgres(DATABASE_URL, { max: 2, prepare: false });
    try {
      await sql`DELETE FROM agent.agent_tool_calls WHERE org_id = ${fixture.orgId}`;
      await sql`DELETE FROM agent.agent_execution_steps WHERE org_id = ${fixture.orgId}`;
      await sql`DELETE FROM agent.agent_executions WHERE org_id = ${fixture.orgId}`;
    } finally {
      await sql.end({ timeout: 5 });
    }
    // teardownFixture's Neo4j cleanup is `MATCH (n) WHERE n.orgId = $orgId
    // DETACH DELETE n` — untargeted by label, so it also removes the
    // Execution/SourceFile nodes seeded above.
    await teardownFixture({ orgSlug: ORG_SLUG });
  });

  test("renders the Debug panel above the span tree, and the span tree still renders", async ({
    page,
    context,
  }) => {
    await loginWithSession(context, fixture.sessionToken);

    await page.goto(`/${ORG_SLUG}/${WS_SLUG}/activity/${execPublicId}`);
    await expect(page.getByRole("heading", { name: execPublicId })).toBeVisible({
      timeout: 20_000,
    });

    // Debug panel renders with real data — the failure_reason-derived error
    // class and message, not an empty shell.
    const debugPanel = page.getByTestId("run-debug-panel");
    await expect(debugPanel).toBeVisible({ timeout: 20_000 });
    await expect(debugPanel.getByText("TypeError").first()).toBeVisible();
    await expect(debugPanel.getByText(FAILURE_REASON)).toBeVisible();
    await expect(debugPanel.getByText(/get_ontology_neighbors/)).toBeVisible();

    // Span tree still renders (the failed tool call from the seeded step).
    const spanTree = page.getByTestId("run-span-tree");
    await expect(spanTree).toBeVisible({ timeout: 20_000 });
    await expect(spanTree.getByText("get_ontology_neighbors").first()).toBeVisible();

    // DOM order: the debug panel precedes the span tree (per the run-detail
    // spec, the failure frame renders ABOVE the trace).
    const debugPanelIsBeforeSpanTree = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="run-debug-panel"]');
      const tree = document.querySelector('[data-testid="run-span-tree"]');
      if (!panel || !tree) return false;
      // DOCUMENT_POSITION_FOLLOWING (4) set on `tree` means `tree` comes AFTER
      // `panel` in document order.
      return Boolean(panel.compareDocumentPosition(tree) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(debugPanelIsBeforeSpanTree).toBe(true);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "activity-failed-run-debug-panel.png"),
      fullPage: true,
    });
  });

  test("renders the populated file-lineage graph for the same failed run", async ({
    page,
    context,
  }) => {
    await loginWithSession(context, fixture.sessionToken);

    await page.goto(`/${ORG_SLUG}/${WS_SLUG}/activity/${execPublicId}`);
    await expect(page.getByRole("heading", { name: execPublicId })).toBeVisible({
      timeout: 20_000,
    });

    // Populated lineage section — NOT the null/empty state (LineageSection
    // renders nothing when `lineage.files.length === 0`).
    await expect(page.getByText("Execution file lineage")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/1 file touched/)).toBeVisible();
    await expect(page.getByText("Touched files (1)")).toBeVisible();
    // The touched file is cited by its human displayName (NodeRef chip),
    // never a raw id (CLAUDE.md "Citing nodes & edges").
    await expect(page.getByText(FILE_DISPLAY_NAME)).toBeVisible();

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "activity-failed-run-lineage.png"),
      fullPage: true,
    });
  });
});
