/**
 * eval-run-detail — e2e spec for Workspace → Evals → Run detail
 * (`/{org}/{ws}/evals/runs/[runId]`, web-app-2.0 Phase 1).
 *
 * The page (run-detail-section.tsx → eval.run.get) reads a run summary from
 * Postgres (eval.eval_runs / eval.eval_datasets) joined with per-item results
 * from ClickHouse (eval_item_results — see packages/telemetry/src/eval-item-results.ts
 * and packages/handlers/src/eval.run.get.ts). Per-item detail lives ONLY in
 * ClickHouse; there is no Postgres table for it. This spec seeds BOTH stores
 * directly so the page renders real, non-mock data end to end:
 *   - org/workspace/user/session via the shared agent-runtime-fixture helper
 *     (raw `postgres` inserts, same as agent-trace-get.spec.ts)
 *   - eval.eval_datasets + eval.eval_runs rows via raw SQL (same client)
 *   - eval_item_results rows via a raw ClickHouse HTTP insert (JSONEachRow) —
 *     no client library needed, mirroring the "raw postgres client" pattern
 *     the fixture already uses for Postgres
 *
 * Two scenarios:
 *   1. A seeded completed run renders its summary (status, avg score, pass
 *      rate, judge, target) and its per-item results table.
 *   2. An unknown runId renders the shared ErrorState, not a crash.
 *
 * Screenshots go to apps/app/e2e/screenshots/eval-run-detail/ (gitignored).
 */
import { test, expect } from "@playwright/test";
import postgres from "postgres";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loginWithSession } from "./helpers/auth";
import { gotoStable } from "./helpers/nav";
import {
  setupAgentRuntimeFixture,
  teardownFixture,
  type AgentRuntimeFixture,
} from "./helpers/agent-runtime-fixture";

const SCREENSHOT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "screenshots",
  "eval-run-detail",
);

function deQuote(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  return raw;
}

const DATABASE_URL = deQuote(
  process.env.DATABASE_URL,
  "postgres://oxagen:oxagen@localhost:5432/oxagen",
);
const CLICKHOUSE_URL = deQuote(process.env.CLICKHOUSE_URL, "http://localhost:8123");
const CLICKHOUSE_USERNAME = deQuote(process.env.CLICKHOUSE_USERNAME, "default");
const CLICKHOUSE_PASSWORD = deQuote(process.env.CLICKHOUSE_PASSWORD, "");
const CLICKHOUSE_DATABASE = deQuote(process.env.CLICKHOUSE_DATABASE, "oxagen");

// Mirrors packages/telemetry/src/eval-item-results.ts EvalItemResultRow —
// kept local so this spec has no runtime dependency on @oxagen/telemetry.
interface EvalItemResultRow {
  org_id: string;
  workspace_id: string;
  run_id: string;
  dataset_id: string;
  item_id: string;
  target_kind: string;
  model: string;
  judge_model: string;
  score: number;
  correctness: number;
  faithfulness: number;
  passed: 0 | 1;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd_micros: number;
  status: "completed" | "failed";
  error_class: string;
  output: string;
  rationale: string;
}

async function insertEvalItemResults(rows: EvalItemResultRow[]): Promise<void> {
  if (rows.length === 0) return;
  const body = rows.map((r) => JSON.stringify(r)).join("\n");
  const url = `${CLICKHOUSE_URL}/?database=${encodeURIComponent(
    CLICKHOUSE_DATABASE,
  )}&query=${encodeURIComponent("INSERT INTO eval_item_results FORMAT JSONEachRow")}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-ClickHouse-User": CLICKHOUSE_USERNAME,
      "X-ClickHouse-Key": CLICKHOUSE_PASSWORD,
      "Content-Type": "text/plain",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`eval-run-detail: ClickHouse insert failed (${res.status}): ${text}`);
  }
}

async function deleteEvalItemResults(runId: string): Promise<void> {
  const url = `${CLICKHOUSE_URL}/?database=${encodeURIComponent(
    CLICKHOUSE_DATABASE,
  )}&query=${encodeURIComponent(
    "ALTER TABLE eval_item_results DELETE WHERE run_id = {runId:String}",
  )}&param_runId=${encodeURIComponent(runId)}`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "X-ClickHouse-User": CLICKHOUSE_USERNAME, "X-ClickHouse-Key": CLICKHOUSE_PASSWORD },
    });
  } catch {
    // Best-effort — a local dev ClickHouse the fixture never reached is tolerated.
  }
}

const ORG_SLUG = "e2e-eval-run-org";
const WS_SLUG = "main";
const USER_EMAIL = "e2e+evalrun@oxagen.ai";

let fixture: AgentRuntimeFixture;
let runPublicId: string;

test.describe("eval run detail", () => {
  test.beforeAll(async () => {
    fixture = await setupAgentRuntimeFixture({
      orgSlug: ORG_SLUG,
      workspaceSlug: WS_SLUG,
      userEmail: USER_EMAIL,
    });

    const sfx = fixture.orgId.replace(/-/g, "").slice(0, 16);
    const datasetPublicId = `evd_e2e_${sfx}`;
    runPublicId = `evr_e2e_${sfx}`;

    const sql = postgres(DATABASE_URL, { max: 2, prepare: false });
    try {
      const [dataset] = await sql<{ id: string }[]>`
        INSERT INTO eval.eval_datasets (
          id, public_id, org_id, workspace_id, name, slug, description, source, item_count
        )
        VALUES (
          gen_random_uuid(), ${datasetPublicId}, ${fixture.orgId}, ${fixture.workspaceId},
          'Seeded eval dataset', 'seeded-eval-dataset', 'e2e seed', 'manual', 3
        )
        ON CONFLICT (public_id) DO UPDATE SET item_count = EXCLUDED.item_count
        RETURNING id
      `;
      const datasetId = dataset!.id;

      await sql`
        INSERT INTO eval.eval_runs (
          id, public_id, org_id, workspace_id, dataset_id, name, target, judge_model,
          pass_threshold, status, item_count, completed_count, failed_count, avg_score,
          score_breakdown, started_at, completed_at
        )
        VALUES (
          gen_random_uuid(), ${runPublicId}, ${fixture.orgId}, ${fixture.workspaceId}, ${datasetId},
          'Seeded run', ${'{"kind":"model","model":"claude-3-haiku-20240307"}'}::jsonb,
          'claude-3-5-sonnet-20241022', 0.7, 'completed', 3, 3, 0, 0.73,
          ${'{"correctness":0.72,"faithfulness":0.71}'}::jsonb,
          now() - interval '2 minutes', now()
        )
        ON CONFLICT (public_id) DO UPDATE SET status = 'completed'
      `;

      await insertEvalItemResults([
        {
          org_id: fixture.orgId,
          workspace_id: fixture.workspaceId,
          run_id: runPublicId,
          dataset_id: datasetPublicId,
          item_id: `evi_seed_${sfx}_1`,
          target_kind: "model",
          model: "claude-3-haiku-20240307",
          judge_model: "claude-3-5-sonnet-20241022",
          score: 0.95,
          correctness: 0.91,
          faithfulness: 0.92,
          passed: 1,
          latency_ms: 850,
          input_tokens: 120,
          output_tokens: 64,
          cost_usd_micros: 1200,
          status: "completed",
          error_class: "",
          output: "Paris is the capital of France.",
          rationale: "Matches the expected answer exactly.",
        },
        {
          org_id: fixture.orgId,
          workspace_id: fixture.workspaceId,
          run_id: runPublicId,
          dataset_id: datasetPublicId,
          item_id: `evi_seed_${sfx}_2`,
          target_kind: "model",
          model: "claude-3-haiku-20240307",
          judge_model: "claude-3-5-sonnet-20241022",
          score: 0.85,
          correctness: 0.88,
          faithfulness: 0.8,
          passed: 1,
          latency_ms: 920,
          input_tokens: 140,
          output_tokens: 58,
          cost_usd_micros: 1100,
          status: "completed",
          error_class: "",
          output: "4",
          rationale: "Correct arithmetic.",
        },
        {
          org_id: fixture.orgId,
          workspace_id: fixture.workspaceId,
          run_id: runPublicId,
          dataset_id: datasetPublicId,
          item_id: `evi_seed_${sfx}_3`,
          target_kind: "model",
          model: "claude-3-haiku-20240307",
          judge_model: "claude-3-5-sonnet-20241022",
          score: 0.39,
          correctness: 0.35,
          faithfulness: 0.4,
          passed: 0,
          latency_ms: 1500,
          input_tokens: 200,
          output_tokens: 90,
          cost_usd_micros: 1800,
          status: "completed",
          error_class: "",
          output: "I don't know.",
          rationale: "Failed to answer the question correctly.",
        },
      ]);
    } finally {
      await sql.end({ timeout: 5 });
    }

    fs.rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  test.afterAll(async () => {
    const sql = postgres(DATABASE_URL, { max: 2, prepare: false });
    try {
      await sql`DELETE FROM eval.eval_runs WHERE org_id = ${fixture.orgId}`;
      await sql`DELETE FROM eval.eval_datasets WHERE org_id = ${fixture.orgId}`;
    } finally {
      await sql.end({ timeout: 5 });
    }
    await deleteEvalItemResults(runPublicId);
    await teardownFixture({ orgSlug: ORG_SLUG });
  });

  test("renders a seeded run's summary and per-item results table", async ({ page, context }) => {
    await loginWithSession(context, fixture.sessionToken);

    await gotoStable(page, `/${ORG_SLUG}/${WS_SLUG}/evals/runs/${runPublicId}`);

    const detail = page.getByTestId("eval-run-detail");
    await expect(detail).toBeVisible({ timeout: 20_000 });

    // Summary — status, avg score, pass rate, judge, target. The status
    // Badge's `capitalize` class is CSS text-transform only — the DOM text
    // content stays lowercase ("completed"), and `exact: true` disambiguates
    // it from the "3/3 completed" items line below.
    await expect(detail.getByText("completed", { exact: true })).toBeVisible();
    await expect(detail.getByText("0.73")).toBeVisible();
    await expect(detail.getByText(/67% \(2\/3\)/)).toBeVisible();
    await expect(detail.getByText("claude-3-5-sonnet-20241022")).toBeVisible();
    await expect(detail.getByText(/Model: claude-3-haiku-20240307/)).toBeVisible();
    await expect(detail.getByText("3/3 completed")).toBeVisible();

    // Per-item results table.
    const table = page.getByTestId("eval-run-results-table");
    await expect(table).toBeVisible();
    // Count the pass/fail BADGES, not every "Passed" on screen: the table grew
    // a "Passed" column header, so a plain text match counts three (header +
    // two rows). Cells exclude the <th>.
    await expect(table.getByRole("cell", { name: "Passed" })).toHaveCount(2);
    await expect(table.getByRole("cell", { name: "Failed" })).toHaveCount(1);
    await expect(table.getByText("0.95")).toBeVisible();
    await expect(table.getByText("850 ms")).toBeVisible();

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "run-detail.png"),
      fullPage: true,
    });
  });

  test("shows an error state for an unknown runId", async ({ page, context }) => {
    await loginWithSession(context, fixture.sessionToken);

    await gotoStable(page, `/${ORG_SLUG}/${WS_SLUG}/evals/runs/evr_does_not_exist`);

    // An unknown run id makes eval.run.get throw, and run-detail-section.tsx
    // treats a failed read — "run not found" included — as an error rather
    // than empty data, so this route renders the shared ErrorState. Reaching
    // RunDetailClient's own `eval-run-empty-state` needs a SUCCESSFUL read
    // that returns `run: null`, which this route cannot produce.
    const errorState = page.getByRole("main").getByRole("alert");
    await expect(errorState).toBeVisible({ timeout: 20_000 });
    await expect(errorState).toContainText("Couldn't load this run");
    await expect(errorState).toContainText(/may have been deleted/i);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "run-not-found.png"),
      fullPage: true,
    });
  });
});
