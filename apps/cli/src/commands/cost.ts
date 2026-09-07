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
 *
 * Add --json to any mode for machine-readable output.
 *
 * Projection is the local half of the cost story; the *observed* half is
 * platform-reported and lives in `oxagen budget show` (period-to-date spend
 * against the ceiling). The `--session` rollup this command used to offer read
 * the local coding agent's turn store, which was retired with the runtime
 * (ADR-043).
 */
import {
  RATE_CARD,
  compareModels,
  formatUsd,
  projectCost,
  type CostProjection,
} from "@oxagen/billing/rate-card";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

export interface CostOptions {
  in?: number;
  out?: number;
  model?: string;
  rates?: boolean;
  json?: boolean;
}

export function handleCost(
  opts: CostOptions,
  writer: CommandWriter = stdoutWriter,
): void {
  if (opts.rates) return printRates(opts.json ?? false, writer);
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
    out("Or: oxagen cost --rates");
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
