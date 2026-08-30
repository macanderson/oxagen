/**
 * Golden fixtures — a real, self-contained corpus + golden trace that
 * instantiates the eval harness (`runEvalSuite`) with concrete data.
 *
 * Until now `packages/engram/src/eval/` was infrastructure with no instantiated
 * golden trace, so the context-quality gate never actually ran. This file is the
 * instantiation: a fixed corpus of repo-grounded memory records and a multi-turn
 * golden trace whose `requiredInContext` / `forbiddenInContext` reference real
 * record ids. Paired with {@link makeGoldenCompileFn} it gives the harness a
 * deterministic context compiler to score — no DuckDB, no LLM, no network — so it
 * runs as a CI regression gate (see golden-suite.test.ts).
 *
 * The questions mirror `bench/context-eval/run_eval.py` so the TS context-quality
 * gate and the Python RAGAS/DeepEval suite (`bench/rag-eval/`) measure the same
 * facts: engram `contextPrecision`/`contextRecall` ↔ RAGAS `context_precision`/
 * `context_recall`.
 */
import type { MemoryRecord } from "../types";
import type { GoldenTrace } from "./golden-traces";
import type { EvalMetrics } from "./metrics";
import type { TaskFrame } from "../retrieval/types";
import type { TokenBudget } from "../compiler/packer";

/**
 * Deterministic 64-char hex id from a seed (record ids are `z.string().length(64)`).
 * A tiny FNV-1a expanded across 8 lanes — pure JS, no blake3/native dep, so the
 * fixture is stable and the gate has no optional-dependency surface.
 */
export function hex64(seed: string): string {
  let out = "";
  for (let lane = 0; lane < 8; lane++) {
    let h = 0x811c9dc5 ^ (lane * 0x01000193);
    const s = `${seed}#${lane}`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}

function semantic(
  seed: string,
  fact: string,
  domain: string,
  salience = 0.7,
): MemoryRecord {
  return {
    id: hex64(seed),
    kind: "semantic",
    namespace: { org: "oxagen", workspace: "eval" },
    body: { fact, domain },
    salience,
    confidence: 0.95,
    provenance: {
      author: "golden-fixtures",
      derivedFrom: [],
      timestamp: 1_700_000_000_000,
    },
    causality: [],
    createdAt: 1_700_000_000_000,
  };
}

/**
 * The corpus. Records 1–5 are the "signal" facts each turn must retrieve; records
 * 6–8 are tenant/domain noise that must NEVER leak into a CLI-structural answer.
 * Signal facts carry a distinctive keyword (DEFAULT_MODEL, runTurn, MUTATING_TOOLS,
 * buildCodeGraph, proxy.ts) that the matching question shares and the noise records
 * do not — so a plain lexical retriever cleanly separates them.
 */
export const GOLDEN_CORPUS: MemoryRecord[] = [
  semantic(
    "cli-default-model",
    "The DEFAULT_MODEL constant in apps/cli/src/agent/model.ts is set to anthropic/claude-sonnet-5.",
    "cli-config",
    0.8,
  ),
  semantic(
    "cli-oneshot-runturn",
    "apps/cli/src/repl/one-shot.ts imports runTurn from ../agent/pipeline.js to run a single agent turn.",
    "cli-oneshot",
  ),
  semantic(
    "cli-mutating-tools",
    "The MUTATING_TOOLS constant in apps/cli/src/agent/permissions.ts lists write_file, edit_file, and bash.",
    "cli-permissions",
  ),
  semantic(
    "cli-codegraph-builder",
    "apps/cli/src/agent/code-graph.ts imports buildCodeGraph from daemon/code-graph/builder.",
    "cli-codegraph",
  ),
  semantic(
    "app-proxy-file",
    "apps/app intercepts requests via proxy.ts, which replaces the old middleware.ts convention.",
    "app-routing",
  ),
  // --- noise: correct facts about other domains, but irrelevant to CLI questions ---
  semantic(
    "noise-billing",
    "Billing credits are the customer-facing currency, bought in US dollars and priced at a cent each.",
    "billing",
  ),
  semantic(
    "noise-rls",
    "Tenant isolation is enforced by withTenantDb / withSystemDb; raw db() is banned.",
    "database",
  ),
  semantic(
    "noise-brand",
    "The Oxagen Graphite skin pairs graphite grays with an ember accent (#F87854).",
    "brand",
  ),
];

const SIGNAL_BUDGET: TokenBudget = {
  total: 4000,
  reserved: { system: 200, procedural: 200, volatile: 3400, working: 200 },
};

function frame(taskDescription: string, workingSet: string[] = []): TaskFrame {
  return {
    namespace: { org: "oxagen", workspace: "eval" },
    taskDescription,
    workingSet,
    recentEventIds: [],
    modelId: "claude-sonnet-5",
  };
}

/**
 * Baseline is set ~10pt below the deterministic compiler's actual score (1.0) so the
 * gate keeps headroom and only fires on a genuine retrieval regression, never on
 * noise. tokensToSuccess / cacheHitRate / costPerTask are 0 because the harness
 * currently hardcodes them to 0 (a baseline of 0 there is skipped by detectRegressions).
 */
const BASELINE: EvalMetrics = {
  contextPrecision: 0.9,
  contextRecall: 0.9,
  retrievalHitRate: 0.9,
  cacheHitRate: 0,
  tokensToSuccess: 0,
  costPerTask: 0,
  turnLatency: { p50: 0, p95: 0, p99: 0 },
};

/**
 * One golden trace, five turns — one per signal fact. Each turn requires its signal
 * record and forbids a noise record, so a correct compile must both find the needle
 * and reject domain noise.
 */
export const GOLDEN_TRACES: GoldenTrace[] = [
  {
    id: "repo-structural-qa",
    name: "Repo-structural Q&A (CLI context engine)",
    description:
      "Five repo-grounded lookups that a code-aware context engine should answer by " +
      "retrieving exactly the relevant fact and excluding unrelated tenant/domain noise.",
    expectedRecords: GOLDEN_CORPUS.slice(0, 5).map((r) => r.id),
    excludedRecords: GOLDEN_CORPUS.slice(5).map((r) => r.id),
    baseline: BASELINE,
    lastValidated: "2026-06-28",
    turns: [
      {
        taskFrame: frame(
          "What is the value of the DEFAULT_MODEL constant in the CLI agent model module?",
        ),
        budget: SIGNAL_BUDGET,
        requiredInContext: [hex64("cli-default-model")],
        forbiddenInContext: [hex64("noise-billing")],
        expectedToolCalls: [],
        expectedOutcome: "success",
      },
      {
        taskFrame: frame(
          "Which function does one-shot.ts import from pipeline to run a single turn? Mention runTurn.",
        ),
        budget: SIGNAL_BUDGET,
        requiredInContext: [hex64("cli-oneshot-runturn")],
        forbiddenInContext: [hex64("noise-brand")],
        expectedToolCalls: [],
        expectedOutcome: "success",
      },
      {
        taskFrame: frame(
          "Name the three tools in the MUTATING_TOOLS constant in the CLI permissions module.",
        ),
        budget: SIGNAL_BUDGET,
        requiredInContext: [hex64("cli-mutating-tools")],
        forbiddenInContext: [hex64("noise-rls")],
        expectedToolCalls: [],
        expectedOutcome: "success",
      },
      {
        taskFrame: frame(
          "Where does the CLI code-graph module import buildCodeGraph from?",
        ),
        budget: SIGNAL_BUDGET,
        requiredInContext: [hex64("cli-codegraph-builder")],
        forbiddenInContext: [hex64("noise-billing")],
        expectedToolCalls: [],
        expectedOutcome: "success",
      },
      {
        taskFrame: frame(
          "Which file does apps/app use for request interception that replaces middleware.ts? It is proxy.ts.",
        ),
        budget: SIGNAL_BUDGET,
        requiredInContext: [hex64("app-proxy-file")],
        forbiddenInContext: [hex64("noise-brand")],
        expectedToolCalls: [],
        expectedOutcome: "success",
      },
    ],
  },
];

/** Ground-truth short answers per turn id (used to export the RAGAS/DeepEval dataset). */
export const GOLDEN_GROUND_TRUTH: Record<string, string> = {
  [hex64("cli-default-model")]: "anthropic/claude-sonnet-5",
  [hex64("cli-oneshot-runturn")]: "runTurn",
  [hex64("cli-mutating-tools")]: "write_file, edit_file, bash",
  [hex64("cli-codegraph-builder")]: "daemon/code-graph/builder",
  [hex64("app-proxy-file")]: "proxy.ts",
};
