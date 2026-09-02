/**
 * `oxagen cost` — make cost projection trivial.
 *
 * The rate card is baked into the CLI, so you never need a spreadsheet to answer
 * "what would this run cost on model X?" or "which model is cheapest for this
 * workload?". Modes:
 *
 *   oxagen cost --in 200000 --out 40000              project on every model, cheapest first
 *   oxagen cost --in 200000 --out 40000 --model …    project on one model
 *   oxagen cost --rates                              print the baked-in rate card
 *   oxagen cost --session                            roll up what THIS project's turns
 *                                                    actually cost, by model (proof)
 *
 * Add --json to any mode for machine-readable output.
 */
import {
  RATE_CARD,
  compareModels,
  formatUsd,
  projectCost,
  type CostProjection,
} from "../agent/rate-card.js";
import { openTraceStore } from "../agent/trace-store.js";
import type { TurnTrace } from "../agent/trace.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

export interface CostOptions {
  in?: number;
  out?: number;
  model?: string;
  rates?: boolean;
  session?: boolean;
  json?: boolean;
}

export async function handleCost(
  opts: CostOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  if (opts.rates) return printRates(opts.json ?? false, writer);
  if (opts.session)
    return printSession(process.cwd(), opts.json ?? false, writer);
  return printProjection(opts, writer);
}

/** Dump the baked-in rate card (USD per 1M tokens). */
function printRates(json: boolean, writer: CommandWriter): void {
  const out = writer.write;
  if (json) {
    out(JSON.stringify(RATE_CARD, null, 2));
    return;
  }
  out("Rate card (USD per 1,000,000 tokens):");
  out("");
  out(
    `  ${"model".padEnd(16)}${"vendor".padEnd(12)}${"input".padStart(10)}${"output".padStart(10)}`,
  );
  for (const e of RATE_CARD) {
    out(
      `  ${e.label.padEnd(16)}${e.vendor.padEnd(12)}` +
        `${("$" + e.rate.inputPer1M).padStart(10)}${("$" + e.rate.outputPer1M).padStart(10)}`,
    );
  }
}

/** Project a token usage across one model or every model (cheapest first). */
function printProjection(opts: CostOptions, writer: CommandWriter): void {
  const out = writer.write;
  const inputTokens = opts.in ?? 0;
  const outputTokens = opts.out ?? 0;
  if (inputTokens === 0 && outputTokens === 0) {
    out(
      "Provide token counts: oxagen cost --in <input> --out <output> [--model <slug>]",
    );
    out("Or: oxagen cost --rates   |   oxagen cost --session");
    process.exitCode = 1;
    return;
  }

  const usage = { inputTokens, outputTokens };
  const rows = opts.model
    ? [projectCost(opts.model, usage)]
    : compareModels(usage);

  if (opts.json) {
    out(JSON.stringify(opts.model ? rows[0] : rows, null, 2));
    return;
  }

  out(
    `Projected cost for ${inputTokens.toLocaleString()} in → ${outputTokens.toLocaleString()} out tokens:`,
  );
  out("");
  out(
    `  ${"model".padEnd(18)}${"input".padStart(12)}${"output".padStart(12)}${"total".padStart(12)}`,
  );
  for (const r of rows) {
    out(
      `  ${(r.label + (r.fallback ? " *" : "")).padEnd(18)}` +
        `${formatUsd(r.inputCostUsd).padStart(12)}${formatUsd(r.outputCostUsd).padStart(12)}` +
        `${formatUsd(r.totalUsd).padStart(12)}`,
    );
  }
  if (!opts.model && rows.length > 1) {
    const cheap = rows[0] as CostProjection;
    const dear = rows[rows.length - 1] as CostProjection;
    const factor =
      cheap.totalUsd > 0 ? (dear.totalUsd / cheap.totalUsd).toFixed(1) : "∞";
    out("");
    out(
      `  cheapest: ${cheap.label} (${formatUsd(cheap.totalUsd)}) — ${factor}× cheaper than ${dear.label}.`,
    );
  }
  if (rows.some((r) => r.fallback))
    out("\n  * no exact rate-card entry; priced at the fallback rate.");
}

interface ModelSpend {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  turns: number;
}

/** Attribute a trace's spend to models — per-phase when available, else the executor. */
function attribute(trace: TurnTrace, byModel: Map<string, ModelSpend>): void {
  const add = (
    model: string,
    inTok: number,
    outTok: number,
    cost: number,
    ms: number,
  ): void => {
    const m = byModel.get(model) ?? {
      model,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      durationMs: 0,
      turns: 0,
    };
    m.inputTokens += inTok;
    m.outputTokens += outTok;
    m.costUsd += cost;
    m.durationMs += ms;
    byModel.set(model, m);
  };
  if (trace.phases?.length) {
    for (const p of trace.phases) {
      if (!p.model) continue;
      add(
        p.model,
        p.usage.inputTokens,
        p.usage.outputTokens,
        p.usage.costUsd,
        p.durationMs,
      );
    }
  } else {
    add(
      trace.selectedModel,
      trace.usage.inputTokens,
      trace.usage.outputTokens,
      trace.usage.costUsd,
      trace.durationMs,
    );
  }
}

/** Roll up what this project's recorded turns actually cost, by model. */
function printSession(cwd: string, json: boolean, writer: CommandWriter): void {
  const out = writer.write;
  const traces = openTraceStore(cwd).list();
  const byModel = new Map<string, ModelSpend>();
  let totalCost = 0;
  let totalMs = 0;
  let totalIn = 0;
  let totalOut = 0;
  for (const t of traces) {
    attribute(t, byModel);
    totalCost += t.usage.costUsd;
    totalMs += t.durationMs;
    totalIn += t.usage.inputTokens;
    totalOut += t.usage.outputTokens;
  }
  // Count turns per model (by executor, the model that did the work).
  for (const t of traces) {
    const m = byModel.get(t.selectedModel);
    if (m) m.turns += 1;
  }
  const spend = [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd);

  if (json) {
    out(
      JSON.stringify(
        {
          turns: traces.length,
          totalCostUsd: totalCost,
          totalDurationMs: totalMs,
          totalInputTokens: totalIn,
          totalOutputTokens: totalOut,
          byModel: spend,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (traces.length === 0) {
    out(
      "No turns recorded for this project yet. Run some prompts, then re-check.",
    );
    return;
  }

  out(
    `Session cost rollup — ${traces.length} turn(s) in ${cwd.split("/").pop()}:`,
  );
  out("");
  out(
    `  ${"model".padEnd(20)}${"turns".padStart(7)}${"tokens".padStart(16)}${"cost".padStart(12)}${"time".padStart(10)}`,
  );
  for (const m of spend) {
    const tok = `${m.inputTokens}→${m.outputTokens}`;
    out(
      `  ${(m.model.split("/").pop() ?? m.model).padEnd(20)}${String(m.turns).padStart(7)}` +
        `${tok.padStart(16)}${formatUsd(m.costUsd).padStart(12)}${(Math.round(m.durationMs / 100) / 10 + "s").padStart(10)}`,
    );
  }
  out("");
  const avgCost = traces.length ? totalCost / traces.length : 0;
  const avgMs = traces.length ? totalMs / traces.length : 0;
  out(
    `  total: ${formatUsd(totalCost)} · ${totalIn + totalOut} tok · ${(totalMs / 1000).toFixed(1)}s   ` +
      `(avg ${formatUsd(avgCost)} · ${(avgMs / 1000).toFixed(1)}s per turn)`,
  );
}
