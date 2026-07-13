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
 * apiPostOrThrow.
 *
 * Output discipline (ADR-023 §4): every handler takes a CommandWriter (default
 * real stdout/stderr; the REPL passes a capture writer) and routes through
 * createOutput. `--json` emits one single-line JSON value on stdout carrying
 * the exact legacy payload shape; pretty mode renders the human table/summary
 * on stdout; and every failure — a client-side usage error (exit 2) or an API
 * failure (exit 1) — is a uniform stderr error line that never touches stdout.
 */
import { readFileSync } from "fs";
import { apiGetOrThrow, apiPostOrThrow, printTable } from "../lib/api.js";
import { formatUsd } from "../agent/rate-card.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

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

// ── eval.dataset.list ─────────────────────────────────────────────────────────

export async function evalDatasetList(
  opts: { json?: boolean } = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const cmd = createOutput({ json: opts.json }, writer);
  let result: { datasets: EvalDatasetSummary[] };
  try {
    result = await apiGetOrThrow<{ datasets: EvalDatasetSummary[] }>(
      "eval/datasets",
    );
  } catch (err) {
    cmd.error(err, "api");
    return;
  }
  const { datasets } = result;
  // Legacy --json shape: the bare array of datasets.
  if (cmd.isJson) {
    cmd.data(datasets);
    return;
  }
  if (datasets.length === 0) {
    writer.write(
      "No eval datasets yet. Create one with `oxagen eval dataset-create <name>`.",
    );
    return;
  }
  printTable(
    ["NAME", "SLUG", "SOURCE", "ITEMS", "PUBLIC ID"],
    datasets.map((d) => [
      d.name,
      d.slug,
      d.source,
      String(d.itemCount),
      d.datasetId,
    ]),
    writer,
  );
}

// ── eval.dataset.get ──────────────────────────────────────────────────────────

export async function evalDatasetGet(
  id: string,
  opts: { limit?: number; cursor?: string; json?: boolean } = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const cmd = createOutput({ json: opts.json }, writer);
  let result: {
    dataset: EvalDatasetSummary;
    items: EvalDatasetItem[];
    nextCursor: string | null;
  };
  try {
    result = await apiGetOrThrow<{
      dataset: EvalDatasetSummary;
      items: EvalDatasetItem[];
      nextCursor: string | null;
    }>("eval/datasets/get", {
      datasetPublicId: id,
      limit: opts.limit,
      cursor: opts.cursor,
    });
  } catch (err) {
    cmd.error(err, "api");
    return;
  }
  // Legacy --json shape: the full { dataset, items, nextCursor } envelope.
  if (cmd.isJson) {
    cmd.data(result);
    return;
  }
  const { dataset, items, nextCursor } = result;
  writer.write(
    `${dataset.name} (${dataset.slug}) — ${dataset.itemCount} item(s), source: ${dataset.source}`,
  );
  if (dataset.description) writer.write(dataset.description);
  writer.write("");
  if (items.length === 0) {
    writer.write("No items on this page.");
  } else {
    printTable(
      ["ITEM ID", "INPUT", "EXPECTED"],
      items.map((i) => [
        i.itemId,
        truncate(i.input, 60),
        i.expectedOutput ? truncate(i.expectedOutput, 40) : "—",
      ]),
      writer,
    );
  }
  if (nextCursor) {
    writer.write(
      `\nMore items available — pass --cursor ${nextCursor} for the next page.`,
    );
  }
}

// ── eval.dataset.create ───────────────────────────────────────────────────────

export async function evalDatasetCreate(
  name: string,
  opts: { slug?: string; description?: string; json?: boolean } = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const cmd = createOutput({ json: opts.json }, writer);
  let result: { datasetId: string; publicId: string; slug: string };
  try {
    result = await apiPostOrThrow<{
      datasetId: string;
      publicId: string;
      slug: string;
    }>("eval/datasets", {
      name,
      slug: opts.slug,
      description: opts.description,
    });
  } catch (err) {
    cmd.error(err, "api");
    return;
  }
  cmd.data(
    result,
    () =>
      `Created eval dataset "${name}" (${result.slug}) — ${result.publicId}`,
  );
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
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const cmd = createOutput({ json: opts.json }, writer);
  let items: EvalItemInput[];
  try {
    items = resolveItems(opts);
  } catch (err) {
    // A bad --file (missing, non-JSON, or not an array) or bad --metadata JSON
    // is a client-side input problem, not an API failure.
    process.exitCode = 2;
    cmd.error(err, "usage");
    return;
  }
  if (items.length === 0) {
    process.exitCode = 2;
    cmd.error(
      "Provide --input <text> (optionally --expected <text> --metadata <json>), or --file <path.json> with an array of items.",
      "usage",
    );
    return;
  }
  let result: { datasetId: string; added: number; itemCount: number };
  try {
    result = await apiPostOrThrow<{
      datasetId: string;
      added: number;
      itemCount: number;
    }>("eval/datasets/items", { datasetPublicId: id, items });
  } catch (err) {
    cmd.error(err, "api");
    return;
  }
  cmd.data(
    result,
    () =>
      `Added ${result.added} item(s) to dataset ${id} — ${result.itemCount} total.`,
  );
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
        metadata: opts.metadata
          ? (JSON.parse(opts.metadata) as Record<string, unknown>)
          : undefined,
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
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const cmd = createOutput({ json: opts.json }, writer);
  let result: {
    datasetId: string;
    publicId: string;
    slug: string;
    itemCount: number;
  };
  try {
    result = await apiPostOrThrow<{
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
  } catch (err) {
    cmd.error(err, "api");
    return;
  }
  cmd.data(
    result,
    () =>
      `Captured ${result.itemCount} item(s) from metered traces into "${name}" (${result.slug}) — ${result.publicId}`,
  );
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
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const cmd = createOutput({ json: opts.json }, writer);
  const target: EvalTarget = opts.agent
    ? { kind: "agent", agentSlug: opts.agent }
    : { kind: "model", model: opts.model, systemPrompt: opts.systemPrompt };
  let result: { runId: string; status: "pending"; itemCount: number };
  try {
    result = await apiPostOrThrow<{
      runId: string;
      status: "pending";
      itemCount: number;
    }>("eval/runs", {
      datasetPublicId: datasetId,
      target,
      judgeModel: opts.judgeModel,
      name: opts.name,
      passThreshold: opts.passThreshold,
      maxItems: opts.maxItems,
    });
  } catch (err) {
    cmd.error(err, "api");
    return;
  }
  cmd.data(
    result,
    () =>
      `Started eval run ${result.runId} — ${result.itemCount} item(s) queued (status: ${result.status}).\n` +
      `Poll with: oxagen eval run-status ${result.runId}`,
  );
}

// ── eval.run.status ───────────────────────────────────────────────────────────

export async function evalRunStatus(
  runId: string,
  opts: { json?: boolean } = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const cmd = createOutput({ json: opts.json }, writer);
  let result: {
    runId: string;
    status: EvalRunStatusValue;
    itemCount: number;
    completedCount: number;
    failedCount: number;
    avgScore: number | null;
    failureReason: string | null;
  };
  try {
    result = await apiGetOrThrow<{
      runId: string;
      status: EvalRunStatusValue;
      itemCount: number;
      completedCount: number;
      failedCount: number;
      avgScore: number | null;
      failureReason: string | null;
    }>("eval/runs/status", { runPublicId: runId });
  } catch (err) {
    cmd.error(err, "api");
    return;
  }
  cmd.data(result, () => {
    const lines = [
      `Run ${result.runId}: ${result.status}`,
      `  progress: ${result.completedCount}/${result.itemCount} completed, ${result.failedCount} failed`,
      `  avg score: ${result.avgScore === null ? "—" : result.avgScore.toFixed(3)}`,
    ];
    if (result.failureReason)
      lines.push(`  failure reason: ${result.failureReason}`);
    return lines.join("\n");
  });
}

// ── eval.run.get ──────────────────────────────────────────────────────────────

export async function evalRunGet(
  runId: string,
  opts: { json?: boolean } = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const cmd = createOutput({ json: opts.json }, writer);
  let result: { run: EvalRunSummary; results: EvalRunResultItem[] };
  try {
    result = await apiGetOrThrow<{
      run: EvalRunSummary;
      results: EvalRunResultItem[];
    }>("eval/runs/get", { runPublicId: runId });
  } catch (err) {
    cmd.error(err, "api");
    return;
  }
  // Legacy --json shape: the full { run, results } envelope.
  if (cmd.isJson) {
    cmd.data(result);
    return;
  }
  const { run, results } = result;
  writer.write(
    `Run ${run.runId} (${run.name ?? "unnamed"}) — ${run.status} — ${run.completedCount}/${run.itemCount} completed, avg score ${run.avgScore === null ? "—" : run.avgScore.toFixed(3)}`,
  );
  writer.write(
    `  target: ${run.target.kind === "agent" ? `agent:${run.target.agentSlug}` : `model:${run.target.model ?? "(default)"}`} · judge: ${run.judgeModel} · pass threshold: ${run.passThreshold}`,
  );
  writer.write("");
  if (results.length === 0) {
    writer.write("No item results yet.");
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
    writer,
  );
}

// ── eval.run.list ─────────────────────────────────────────────────────────────

interface EvalRunListRow {
  runId: string;
  datasetId: string;
  datasetName: string;
  datasetSlug: string;
  name: string | null;
  target: {
    kind: "model" | "agent";
    model: string | null;
    agentSlug: string | null;
  };
  judgeModel: string;
  status: string;
  itemCount: number;
  completedCount: number;
  failedCount: number;
  avgScore: number | null;
  passThreshold: number;
  costUsdMicros: number;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  completedAt: string | null;
}

interface EvalRunListResult {
  runs: EvalRunListRow[];
  total: number;
  allTimeTotal: number;
}

export async function evalRunsList(
  opts: {
    dataset?: string;
    since?: string;
    until?: string;
    status?: string;
    model?: string;
    sort?: string;
    dir?: string;
    limit?: number;
    offset?: number;
    json?: boolean;
  } = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const cmd = createOutput({ json: opts.json }, writer);
  let result: EvalRunListResult;
  try {
    result = await apiGetOrThrow<EvalRunListResult>("eval/runs/list", {
      datasetPublicId: opts.dataset,
      since: opts.since,
      until: opts.until,
      status: opts.status,
      model: opts.model,
      sortBy: opts.sort,
      sortDir: opts.dir,
      limit: opts.limit,
      offset: opts.offset,
    });
  } catch (err) {
    cmd.error(err, "api");
    return;
  }
  if (cmd.isJson) {
    cmd.data(result);
    return;
  }
  const { runs, total, allTimeTotal } = result;
  if (runs.length === 0) {
    writer.write("No eval runs match this filter.");
    writer.write(`showing 0 of ${total} (all-time ${allTimeTotal})`);
    return;
  }
  printTable(
    [
      "RUN ID",
      "DATASET",
      "TARGET",
      "STATUS",
      "SCORE",
      "PROGRESS",
      "COST",
      "CREATED",
    ],
    runs.map((r) => [
      r.runId,
      r.datasetSlug,
      r.target.kind === "agent"
        ? `agent:${r.target.agentSlug ?? "?"}`
        : `model:${r.target.model ?? "(default)"}`,
      r.status,
      r.avgScore === null ? "—" : r.avgScore.toFixed(3),
      `${r.completedCount}/${r.itemCount}${r.failedCount ? ` (${r.failedCount} failed)` : ""}`,
      formatUsd(r.costUsdMicros / 1_000_000),
      r.createdAt,
    ]),
    writer,
  );
  writer.write(
    `\nshowing ${runs.length} of ${total} (all-time ${allTimeTotal})`,
  );
}

// ── eval.run.series ─────────────────────────────────────────────────────────────

interface EvalRunSeriesResult {
  overall: { bucketStart: string; avgScore: number | null; runCount: number }[];
  byModel: {
    model: string;
    vendor: string;
    avgScore: number | null;
    passRate: number;
    runCount: number;
    points: { bucketStart: string; avgScore: number | null }[];
  }[];
}

export async function evalRunsSeries(
  opts: {
    dataset?: string;
    since?: string;
    until?: string;
    bucket?: string;
    json?: boolean;
  } = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const cmd = createOutput({ json: opts.json }, writer);
  let result: EvalRunSeriesResult;
  try {
    result = await apiGetOrThrow<EvalRunSeriesResult>("eval/runs/series", {
      datasetPublicId: opts.dataset,
      since: opts.since,
      until: opts.until,
      bucket: opts.bucket,
    });
  } catch (err) {
    cmd.error(err, "api");
    return;
  }
  if (cmd.isJson) {
    cmd.data(result);
    return;
  }
  const { overall, byModel } = result;
  writer.write("Overall score over time:");
  if (overall.length === 0) {
    writer.write("  (no completed runs in range)");
  } else {
    printTable(
      ["BUCKET", "AVG SCORE", "RUNS"],
      overall.map((b) => [
        b.bucketStart,
        b.avgScore === null ? "—" : b.avgScore.toFixed(3),
        String(b.runCount),
      ]),
      writer,
    );
  }
  writer.write("\nBy model:");
  if (byModel.length === 0) {
    writer.write("  (no completed runs in range)");
  } else {
    printTable(
      ["MODEL", "VENDOR", "AVG SCORE", "PASS RATE", "RUNS"],
      byModel.map((m) => [
        m.model,
        m.vendor,
        m.avgScore === null ? "—" : m.avgScore.toFixed(3),
        `${(m.passRate * 100).toFixed(1)}%`,
        String(m.runCount),
      ]),
      writer,
    );
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
