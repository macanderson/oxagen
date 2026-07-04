/**
 * agent-trace-get — e2e spec for the Activity run-trace surface.
 *
 * Seeds a real agent execution (execution → step → tool call) directly in
 * Postgres for a fixture tenant, injects the fixture's session cookie, then
 * drives the browser through:
 *   1. /{org}/{ws}/activity   — the run appears in the list (real RSC → invoke
 *      → agent.execution.list → Postgres; no mock).
 *   2. click the run          — the span tree renders (execution + step + tool
 *      call), via agent.trace.get.
 *   3. a bogus /activity/aex_… — the not-found card renders (404 path).
 *
 * Screenshots (success states) go to apps/app/e2e/screenshots/ (gitignored).
 */
import { test, expect } from "@playwright/test";
import postgres from "postgres";
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

const ORG_SLUG = "e2e-trace-org";
const WS_SLUG = "main";
const USER_EMAIL = "e2e+trace@oxagen.ai";

let fixture: AgentRuntimeFixture;
let execPublicId: string;

test.describe("agent run-trace span tree", () => {
  test.beforeAll(async () => {
    fixture = await setupAgentRuntimeFixture({
      orgSlug: ORG_SLUG,
      workspaceSlug: WS_SLUG,
      userEmail: USER_EMAIL,
    });

    // Seed one execution → step → tool call, all scoped to the fixture tenant.
    const sfx = fixture.orgId.replace(/-/g, "").slice(0, 16);
    execPublicId = `aex_e2e_${sfx}`;
    const stepPublicId = `aes_e2e_${sfx}`;
    const toolPublicId = `atc_e2e_${sfx}`;

    const sql = postgres(DATABASE_URL, { max: 2, prepare: false });
    try {
      const [exec] = await sql<{ id: string }[]>`
        INSERT INTO agent.agent_executions (
          id, public_id, org_id, workspace_id, origin_type, origin_id, status,
          input_payload, output_payload, started_at, completed_at, latency_ms,
          input_tokens, output_tokens, estimated_cost_usd
        )
        VALUES (
          gen_random_uuid(), ${execPublicId}, ${fixture.orgId}, ${fixture.workspaceId},
          'chat', gen_random_uuid(), 'completed',
          '{"prompt":"e2e"}'::jsonb, '{"answer":"ok"}'::jsonb,
          now() - interval '4 seconds', now(), 4000, 120, 60, 0.012000
        )
        ON CONFLICT (public_id) DO UPDATE SET status = 'completed'
        RETURNING id
      `;
      const executionId = exec!.id;

      const [step] = await sql<{ id: string }[]>`
        INSERT INTO agent.agent_execution_steps (
          id, public_id, execution_id, org_id, workspace_id, step_number,
          step_type, status, input_payload, latency_ms, input_tokens, output_tokens,
          started_at, completed_at
        )
        VALUES (
          gen_random_uuid(), ${stepPublicId}, ${executionId}, ${fixture.orgId}, ${fixture.workspaceId}, 1,
          'tool_call', 'completed', '{}'::jsonb, 1000, 10, 5,
          now() - interval '3 seconds', now() - interval '2 seconds'
        )
        ON CONFLICT (public_id) DO UPDATE SET status = 'completed'
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
          'ontology.neighbors', 'capability', '{"nodeId":"n1"}'::jsonb,
          '{"neighbors":["a","b"]}'::jsonb, 'completed', 800, 4, 2
        )
        ON CONFLICT (public_id) DO UPDATE SET status = 'completed'
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }

    // Reset screenshot dir per run (CLAUDE.md verification discipline).
    fs.rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  test.afterAll(async () => {
    // Delete seeded agent rows in FK-safe order, then the tenant fixture.
    const sql = postgres(DATABASE_URL, { max: 2, prepare: false });
    try {
      await sql`
        DELETE FROM agent.agent_tool_calls WHERE org_id = ${fixture.orgId}
      `;
      await sql`
        DELETE FROM agent.agent_execution_steps WHERE org_id = ${fixture.orgId}
      `;
      await sql`
        DELETE FROM agent.agent_executions WHERE org_id = ${fixture.orgId}
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }
    await teardownFixture({ orgSlug: ORG_SLUG });
  });

  test("lists the run and renders its span tree", async ({ page, context }) => {
    await loginWithSession(context, fixture.sessionToken);

    // ── 1. Activity list shows the seeded run ──
    await page.goto(`/${ORG_SLUG}/${WS_SLUG}/activity`);
    await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible({
      timeout: 20_000,
    });
    const runLink = page.getByText(execPublicId, { exact: false }).first();
    await expect(runLink).toBeVisible({ timeout: 20_000 });
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "activity-list.png"),
      fullPage: true,
    });

    // ── 2. Open the run → span tree renders ──
    await runLink.click();
    await page.waitForURL((url) => url.pathname.includes("/activity/"), {
      timeout: 20_000,
    });
    // The execution id appears as the page heading; the tree shows the tool call.
    await expect(
      page.getByRole("heading", { name: execPublicId }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("ontology.neighbors").first()).toBeVisible({
      timeout: 20_000,
    });
    // The step row is present too.
    await expect(page.getByText("tool_call").first()).toBeVisible();
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "span-tree.png"),
      fullPage: true,
    });
  });

  test("shows the not-found card for an unknown run", async ({ page, context }) => {
    await loginWithSession(context, fixture.sessionToken);
    await page.goto(`/${ORG_SLUG}/${WS_SLUG}/activity/aex_does_not_exist`);
    await expect(page.getByText(/could not be found/i)).toBeVisible({
      timeout: 20_000,
    });
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "trace-not-found.png"),
      fullPage: true,
    });
  });
});
