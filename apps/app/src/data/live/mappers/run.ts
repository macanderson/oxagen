// get_run, get_run_cost and get_run_transcript to the Run page's view models
// (ARCHITECTURE.md §3.4). Typed from each contract's `_output`, so a field the
// contract may omit cannot land in a required view field.
//
// The header maps through `toRunRow`, the same function the Fleet table's rows
// go through, so the two surfaces cannot disagree about one run.
import type { runCostGet } from "@oxagen/oxagen/contracts/run.cost";
import type { runGet } from "@oxagen/oxagen/contracts/run.get";
import type { runTranscriptGet } from "@oxagen/oxagen/contracts/run.transcript.get";
import type { z } from "zod";
import { moneyFromMicros } from "@/data/contracts/money";
import type { RunCost, RunDetail, RunTranscript } from "@/data/contracts/run";
import type { ContractOutput } from "@/server/kernel";
import { toRunRow } from "./runs";

type RunGetOutput = ContractOutput<typeof runGet>;
type RunCostOutput = ContractOutput<typeof runCostGet>;
type RunTranscriptOutput = ContractOutput<typeof runTranscriptGet>;

type ContractCost = { micros: string; currency: string; basis: string | null };

/** A metered figure keeps the basis that says who observed it (INV-09, INV-10). */
function toCost(cost: ContractCost | null) {
  return cost === null
    ? null
    : { ...moneyFromMicros(cost.micros, cost.currency), basis: cost.basis };
}

type ContractTokens = {
  input_uncached: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
  output: number;
  reasoning: number;
};

/** The rollup's snake_case token classes, in the app's own spelling. */
function toTokens(tokens: ContractTokens) {
  return {
    inputUncached: tokens.input_uncached,
    cacheRead: tokens.cache_read,
    cacheWrite5m: tokens.cache_write_5m,
    cacheWrite1h: tokens.cache_write_1h,
    output: tokens.output,
    reasoning: tokens.reasoning,
  };
}

export function toRunDetail(out: RunGetOutput): z.input<typeof RunDetail> {
  return {
    run: toRunRow(out.run),
    frames: {
      frames: out.frames.frames.map((frame) => ({
        cursor: frame.cursor,
        seq: frame.seq,
        type: frame.type,
        stage: frame.stage,
        observedAt: frame.observedAt,
        digest: frame.digest,
        summary: frame.summary,
        body: {
          digest: frame.body.digest,
          bytesRef: frame.body.bytesRef,
          redactions: frame.body.redactions.map((redaction) => ({
            path: redaction.path,
            reason: redaction.reason,
            originalDigest: redaction.originalDigest,
          })),
          fidelity: frame.body.fidelity,
        },
        cost: toCost(frame.cost),
      })),
      cursor: out.frames.cursor,
    },
    witnessed: out.witnessFor !== null,
  };
}

export function toRunCost(out: RunCostOutput): z.input<typeof RunCost> {
  const { rollup } = out;
  return {
    rollup:
      rollup === null
        ? null
        : {
            cost: toCost(rollup.cost),
            tokens: toTokens(rollup.tokens),
            cacheHitRate: rollup.cacheHitRate,
            turns: rollup.turns,
            steps: rollup.steps,
            modelCalls: rollup.modelCalls,
            toolCalls: rollup.toolCalls,
            retries: rollup.retries,
            productiveRatio: rollup.productiveRatio,
            byModel: rollup.byModel.map((row) => ({
              model: row.model,
              provider: row.provider,
              calls: row.calls,
              cost: toCost(row.cost),
              tokens: toTokens(row.tokens),
            })),
            byTool: rollup.byTool.map((row) => ({
              name: row.name,
              calls: row.calls,
            })),
            priceEntryIds: rollup.priceEntryIds,
            rolledUpAt: rollup.rolledUpAt,
          },
  };
}

export function toRunTranscript(
  out: RunTranscriptOutput,
): z.input<typeof RunTranscript> {
  return {
    zoom: out.zoom,
    entries: out.entries.map((entry) => ({
      seq: entry.seq,
      endSeq: entry.endSeq,
      at: entry.at,
      kind: entry.kind,
      type: entry.type,
      label: entry.label,
      text: entry.text,
      truncated: entry.truncated,
      fidelity: entry.fidelity,
      frames: entry.frames,
      cost: toCost(entry.cost),
    })),
    complete: out.complete,
  };
}
