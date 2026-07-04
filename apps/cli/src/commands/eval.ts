/**
 * `oxagen eval …` — datasets and runs for the eval.* capability family.
 *
 * Datasets are named, workspace-scoped collections of cases scored against a
 * target (a model+prompt or an agent) with an LLM judge. Items land in a
 * dataset either one batch at a time (`eval dataset item-add`) or captured
 * straight from real, already-metered production traces
 * (`eval from-traces`) — score what actually ran, not synthetic prompts.
 *
 * Runs are async: `eval run` enqueues a background job and returns
 * immediately with a runId; poll `eval run-status` (cheap header) or
 * `eval run-get` (full per-item detail) for results. Target and judge calls
 * are metered through @oxagen/ai like any other AI call in the platform.
 *
 * All calls go through the shared org-scoped API client in lib/api.ts — no
 * bespoke HTTP here. GET routes use apiGetOrThrow, POST routes use
 * apiPostOrThrow; both throw ApiError on failure, which the CLI's top-level
 * fatal handler (index.tsx) renders as a clean `Error: <message>` line.
 */
import { readFileSync } from "fs";
import { apiGetOrThrow, apiPostOrThrow, printTable } from "../lib/api.js";
import { formatUsd } from "../agent/rate-card.js";

const out = (s: string): void => void process.stdout.write(s + "\n");

// ── Shared output shapes (mirror the eval.* contract outputs) ────────────────

interface EvalDatasetSummary {
  datasetId: string;
  name: string;
  slug: string;
  description: string | null;
  source: "manual" | "traces";
  itemCount: number;
  createdAt: string;
}

interface EvalDatasetItem {
  itemId: string;
  input: string;
  expectedOutput: string | null;
  metadata: Record<string, unknown>;
}

type EvalTarget =
  | { kind: "model"; model?: string; systemPrompt?: string }
  | { kind: "agent"; agentSlug: string };

type EvalRunStatusValue =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

interface EvalRunSummary {
  runId: string;
  datasetId: string;
  name: string | null;
  target: EvalTarget;
  judgeModel: string;
  passThreshold: number;
  status: EvalRunStatusValue;
  itemCount: number;
  completedCount: number;
  failedCount: number;
  avgScore: number | null;
  scoreBreakdown: Record<string, number>;
  createdAt: string;
}

interface EvalRunResultItem {
  itemId: string;
  targetKind: string;
  model: string;
  judgeModel: string;
  score: number;
  correctness: number;
  faithfulness: number;
  passed: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsdMicros: number;
  status: "completed" | "failed";
  errorClass: string;
  output: string;
  rationale: string;
}

function printJsonOr<T>(value: T, json: boolean | undefined, render: (v: T) => void): void {
  if (json) {
    out(JSON.stringify(value, null, 2));
    return;
  }
  render(value);
}

// ── eval.dataset.list ─────────────────────────────────────────────────────────

export async function evalDatasetList(opts: { json?: boolean } = {}): Promise<void> {
  const { datasets } = await apiGetOrThrow<{ datasets: EvalDatasetSummary[] }>(
    "eval/datasets",
  );
  printJsonOr(datasets, opts.json, (rows) => {
    if (rows.length === 0) {
      out("No eval datasets yet. Create one with `oxagen eval dataset-create <name>`.");
      return;
    }
    printTable(
      ["NAME", "SLUG", "SOURCE", "ITEMS", "PUBLIC ID"],
      rows.map((d) => [d.name, d.slug, d.source, String(d.itemCount), d.datasetId]),
    );
  });
}

// ── eval.dataset.get ──────────────────────────────────────────────────────────

export async function evalDatasetGet(
  id: string,
  opts: { limit?: number; cursor?: string; json?: boolean } = {},
): Promise<void> {
  const result = await apiGetOrThrow<{
    dataset: EvalDatasetSummary;
    items: EvalDatasetItem[];
    nextCursor: string | null;
  }>("eval/datasets/get", {
    datasetPublicId: id,
    limit: opts.limit,
    cursor: opts.cursor,
  });
  printJsonOr(result, opts.json, ({ dataset, items, nextCursor }) => {
    out(`${dataset.name} (${dataset.slug}) — ${dataset.itemCount} item(s), source: ${dataset.source}`);
    if (dataset.description) out(dataset.description);
    out("");
    if (items.length === 0) {
      out("No items on this page.");
    } else {
      printTable(
        ["ITEM ID", "INPUT", "EXPECTED"],
        items.map((i) => [
          i.itemId,
          truncate(i.input, 60),
          i.expectedOutput ? truncate(i.expectedOutput, 40) : "—",
        ]),
      );
    }
    if (nextCursor) out(`\nMore items available — pass --cursor ${nextCursor} for the next page.`);
  });
}

// ── eval.dataset.create ───────────────────────────────────────────────────────

export async function evalDatasetCreate(
  name: string,
  opts: { slug?: string; description?: string; json?: boolean } = {},
): Promise<void> {
  const result = await apiPostOrThrow<{ datasetId: string; publicId: string; slug: string }>(
    "eval/datasets",
    { name, slug: opts.slug, description: opts.description },
  );
  printJsonOr(result, opts.json, (r) => {
    out(`Created eval dataset "${name}" (${r.slug}) — ${r.publicId}`);
  });
}

// ── eval.dataset.item.add ─────────────────────────────────────────────────────

interface EvalItemInput {
  input: string;
  expectedOutput?: string;
  metadata?: Record<string, unknown>;
}

export async function evalDatasetItemAdd(
  id: string,
  opts: {
    input?: string;
    expected?: string;
    metadata?: string;
    file?: string;
    json?: boolean;
  } = {},
): Promise<void> {
  const items = resolveItems(opts);
  if (items.length === 0) {
    process.stderr.write(
      "Provide --input <text> (optionally --expected <text> --metadata <json>), or --file <path.json> with an array of items.\n",
    );
    process.exitCode = 1;
    return;
  }
  const result = await apiPostOrThrow<{ datasetId: string; added: number; itemCount: number }>(
    "eval/datasets/items",
    { datasetPublicId: id, items },
  );
  printJsonOr(result, opts.json, (r) => {
    out(`Added ${r.added} item(s) to dataset ${id} — ${r.itemCount} total.`);
  });
}

function resolveItems(opts: {
  input?: string;
  expected?: string;
  metadata?: string;
  file?: string;
}): EvalItemInput[] {
  if (opts.file) {
    const raw = readFileSync(opts.file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`--file ${opts.file} must contain a JSON array of items`);
    }
    return parsed as EvalItemInput[];
  }
  if (opts.input) {
    return [
      {
        input: opts.input,
        expectedOutput: opts.expected,
        metadata: opts.metadata ? (JSON.parse(opts.metadata) as Record<string, unknown>) : undefined,
      },
    ];
  }
  return [];
}

// ── eval.dataset.from_traces ──────────────────────────────────────────────────

export async function evalDatasetFromTraces(
  name: string,
  opts: {
    slug?: string;
    description?: string;
    capability?: string;
    sinceHours?: number;
    limit?: number;
    json?: boolean;
  } = {},
): Promise<void> {
  const result = await apiPostOrThrow<{
    datasetId: string;
    publicId: string;
    slug: string;
    itemCount: number;
  }>("eval/datasets/from-traces", {
    name,
    slug: opts.slug,
    description: opts.description,
    capabilityName: opts.capability,
    sinceHours: opts.sinceHours,
    limit: opts.limit,
  });
  printJsonOr(result, opts.json, (r) => {
    out(
      `Captured ${r.itemCount} item(s) from metered traces into "${name}" (${r.slug}) — ${r.publicId}`,
    );
  });
}

// ── eval.run.start ────────────────────────────────────────────────────────────

export async function evalRunStart(
  datasetId: string,
  opts: {
    model?: string;
    systemPrompt?: string;
    agent?: string;
    judgeModel?: string;
    name?: string;
    passThreshold?: number;
    maxItems?: number;
    json?: boolean;
  } = {},
): Promise<void> {
  const target: EvalTarget = opts.agent
    ? { kind: "agent", agentSlug: opts.agent }
    : { kind: "model", model: opts.model, systemPrompt: opts.systemPrompt };
  const result = await apiPostOrThrow<{ runId: string; status: "pending"; itemCount: number }>(
    "eval/runs",
    {
      datasetPublicId: datasetId,
      target,
      judgeModel: opts.judgeModel,
      name: opts.name,
      passThreshold: opts.passThreshold,
      maxItems: opts.maxItems,
    },
  );
  printJsonOr(result, opts.json, (r) => {
    out(`Started eval run ${r.runId} — ${r.itemCount} item(s) queued (status: ${r.status}).`);
    out(`Poll with: oxagen eval run-status ${r.runId}`);
  });
}

// ── eval.run.status ───────────────────────────────────────────────────────────

export async function evalRunStatus(runId: string, opts: { json?: boolean } = {}): Promise<void> {
  const result = await apiGetOrThrow<{
    runId: string;
    status: EvalRunStatusValue;
    itemCount: number;
    completedCount: number;
    failedCount: number;
    avgScore: number | null;
    failureReason: string | null;
  }>("eval/runs/status", { runPublicId: runId });
  printJsonOr(result, opts.json, (r) => {
    out(`Run ${r.runId}: ${r.status}`);
    out(`  progress: ${r.completedCount}/${r.itemCount} completed, ${r.failedCount} failed`);
    out(`  avg score: ${r.avgScore === null ? "—" : r.avgScore.toFixed(3)}`);
    if (r.failureReason) out(`  failure reason: ${r.failureReason}`);
  });
}

// ── eval.run.get ──────────────────────────────────────────────────────────────

export async function evalRunGet(runId: string, opts: { json?: boolean } = {}): Promise<void> {
  const result = await apiGetOrThrow<{ run: EvalRunSummary; results: EvalRunResultItem[] }>(
    "eval/runs/get",
    { runPublicId: runId },
  );
  printJsonOr(result, opts.json, ({ run, results }) => {
    out(
      `Run ${run.runId} (${run.name ?? "unnamed"}) — ${run.status} — ${run.completedCount}/${run.itemCount} completed, avg score ${run.avgScore === null ? "—" : run.avgScore.toFixed(3)}`,
    );
    out(`  target: ${run.target.kind === "agent" ? `agent:${run.target.agentSlug}` : `model:${run.target.model ?? "(default)"}`} · judge: ${run.judgeModel} · pass threshold: ${run.passThreshold}`);
    out("");
    if (results.length === 0) {
      out("No item results yet.");
      return;
    }
    printTable(
      ["ITEM ID", "SCORE", "PASS", "TOKENS", "COST", "STATUS"],
      results.map((r) => [
        r.itemId,
        r.score.toFixed(3),
        r.passed ? "✓" : "✗",
        `${r.inputTokens}→${r.outputTokens}`,
        formatUsd(r.costUsdMicros / 1_000_000),
        r.status,
      ]),
    );
  });
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
