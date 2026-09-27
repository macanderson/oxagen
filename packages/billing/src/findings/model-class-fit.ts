/**
 * Model class fit (detector 4, ADR-208): a run that read files and changed
 * none, repriced as if the next smaller model class of the same vendor had
 * run it. The saving is an estimate, so every figure carries the `estimated`
 * basis until a replay on the smaller class confirms it. It claims no frame
 * and stays out of the unproductive spend headline (counting rule 2).
 *
 * A run counts when it is sealed, its tool calls were all read (it started at
 * or after the tool-call window), it made at least one tool call, and the
 * classifier marked every call as one that changes nothing. A call the
 * classifier said nothing about may have written, so it rules the run out. A
 * run with a spin loop is left out, so detector 1 keeps its spend.
 *
 * The measured side is what the rollup priced for each model the run used.
 * The counterfactual swaps each model that has a smaller class for that
 * class's model at list price, and keeps every other model at its measured
 * cost. Cited at the run's agent, or at its operator when it names no agent.
 */
import { MODEL_CLASS_LADDERS } from "@oxagen/oxagen/run-fit";
import {
  classesToResolve,
  priceClasses,
  type ResolvedClassEntries,
} from "../class-cost";
import {
  divideHalfEven,
  type ModelBreakdown,
  type RunTotalsRecord,
} from "../cost-rollup";
import {
  COLD_BOOK_EFFECTIVE_FROM,
  resolvePriceEntry,
  type PriceBook,
} from "../price-book";
import { inCodeCardPrices, seedsFromPublishedPrices } from "../price-sources";
import { spinCalls } from "./spin-loops";
import {
  agentOrOperator,
  plural,
  type DetectContext,
  type Detector,
  type DetectInput,
  type Group,
  type Measure,
} from "./shared";

const MILLION = 1_000_000n;

/**
 * The model each vendor's class is repriced at, by class. The price book
 * holds models, not classes, so this names the model that stands for a
 * class. A vendor or class absent here has no model to reprice at, and a run
 * on it keeps its measured cost.
 */
const CLASS_MODELS: Readonly<Record<string, Readonly<Record<string, string>>>> =
  {
    anthropic: { sonnet: "claude-sonnet-5", haiku: "claude-haiku-4-5" },
    openai: { nano: "gpt-5-nano" },
  };

/** Every class word on a ladder, for reading a class out of a model id. */
const CLASS_WORDS = new Set(MODEL_CLASS_LADDERS.flat());

/** The vendor a model breakdown names, or the one its id starts with. */
function vendorOf(m: ModelBreakdown): string | null {
  if (m.provider !== null && m.provider.length > 0)
    return m.provider.toLowerCase();
  const id = m.model.toLowerCase();
  const cut = id.search(/[/:]/);
  if (cut > 0) return id.slice(0, cut);
  if (id.startsWith("claude")) return "anthropic";
  if (id.startsWith("gpt")) return "openai";
  return null;
}

/**
 * The capability class a model id names, read as whole words from the part
 * after any `vendor/` or `vendor:` prefix. `flash-lite` spans two words, so
 * it is read first.
 */
function classOf(modelId: string): string | null {
  const id = modelId.toLowerCase();
  const name = id.slice(Math.max(id.lastIndexOf("/"), id.lastIndexOf(":")) + 1);
  if (name.includes("flash-lite") && CLASS_WORDS.has("flash-lite"))
    return "flash-lite";
  for (const word of name.split(/[^a-z0-9]+/))
    if (CLASS_WORDS.has(word)) return word;
  return null;
}

/**
 * The model a breakdown is repriced at: the next smaller class on the ladder
 * that holds its class, as its own vendor names that class. Null when the
 * class is the smallest, sits on no ladder, or its vendor has no model for
 * the smaller class.
 */
export function lighterModel(m: ModelBreakdown): string | null {
  const vendor = vendorOf(m);
  const cls = classOf(m.model);
  if (vendor === null || cls === null) return null;
  const models = CLASS_MODELS[vendor];
  if (models === undefined) return null;
  for (const ladder of MODEL_CLASS_LADDERS) {
    const rank = ladder.indexOf(cls);
    if (rank < 1) continue;
    const smaller = ladder[rank - 1]!;
    return Object.hasOwn(models, smaller) ? models[smaller]! : null;
  }
  return null;
}

let listBook: PriceBook | null = null;

/**
 * The list book the in-code rate card describes, built once. It carries no
 * organization's negotiated rows, so the counterfactual is at list price.
 */
export function inCodeListBook(): PriceBook {
  listBook ??= seedsFromPublishedPrices(
    inCodeCardPrices(),
    COLD_BOOK_EFFECTIVE_FROM,
  ).map(({ catalog, source, ...seed }) => ({
    ...seed,
    id: `${catalog ?? "list"}:${seed.model}:${seed.tokenClass}`,
    orgId: null,
    source: source ?? "list",
  }));
  return listBook;
}

/** One model's tokens at another model's prices, or null when a class has no price. */
function repriceAt(
  book: PriceBook,
  run: RunTotalsRecord,
  m: ModelBreakdown,
  modelId: string,
): bigint | null {
  const entries: ResolvedClassEntries = {};
  for (const c of classesToResolve(m.tokens))
    entries[c] = resolvePriceEntry(book, {
      orgId: run.orgId,
      modelId,
      tokenClass: c,
      at: run.startedAt,
    });
  const priced = priceClasses(entries, m.tokens);
  if (priced.missedClasses.length > 0) return null;
  return divideHalfEven(priced.scaled, MILLION);
}

/** Every token the run carried; a server tool request counts requests, so it is left out. */
function runTokens(run: RunTotalsRecord): number {
  const { server_tool_request: _requests, ...tokens } = run.tokens;
  return Object.values(tokens).reduce((sum, n) => sum + n, 0);
}

/**
 * The run's measured cost against its cost with each model moved down one
 * class. Not covered when the rollup could not price the run in full, or the
 * book has no price for a class the smaller model would have billed.
 */
function measureRun(book: PriceBook, run: RunTotalsRecord): Measure {
  const tokens = runTokens(run);
  const uncovered: Measure = {
    measuredTokens: tokens,
    counterfactualTokens: tokens,
    micros: null,
    basis: "estimated",
  };
  if (run.costBasis === null || run.costBasis === "estimated") return uncovered;
  let measured = 0n;
  let counterfactual = 0n;
  for (const m of run.breakdown.models) {
    if (m.costMicros === null || m.hasUnpriced) return uncovered;
    measured += m.costMicros;
    const lighter = lighterModel(m);
    if (lighter === null) {
      counterfactual += m.costMicros;
      continue;
    }
    const repriced = repriceAt(book, run, m, lighter);
    if (repriced === null) return uncovered;
    counterfactual += repriced;
  }
  return { ...uncovered, micros: { measured, counterfactual } };
}

function detectWith(
  book: PriceBook,
  input: DetectInput,
  ctx: DetectContext,
): void {
  for (const view of ctx.views) {
    const { run } = view;
    // A run still going may write later, and a run that started before the
    // tool-call window may have written in a call the pass did not read.
    if (run.sealedAt === null) continue;
    if (run.startedAt.getTime() < input.toolWindowStart.getTime()) continue;
    if (!view.calls.every((c) => c.call.isMutating === false)) continue;
    if (spinCalls(view.calls).size > 0) continue;
    if (!run.breakdown.models.some((m) => lighterModel(m) !== null)) continue;
    const key = agentOrOperator("model_class_fit", run);
    if (key === null || !ctx.groups.admits(key, run)) continue;
    // The finding is about the run's model as a whole, not a call.
    ctx.groups.add(key, input.window.start, run, measureRun(book, run), null);
  }
}

/** Each model the group's runs moved down a class, as "from to", largest measured cost first. */
function moves(group: Group): { text: string; lighter: string | null } {
  const byMove = new Map<string, { lighter: string; micros: bigint }>();
  for (const { run } of group.runs.values())
    for (const m of run.breakdown.models) {
      const lighter = lighterModel(m);
      if (lighter === null) continue;
      const move = `${m.model} to ${lighter}`;
      const seen = byMove.get(move) ?? { lighter, micros: 0n };
      seen.micros += m.costMicros ?? 0n;
      byMove.set(move, seen);
    }
  const ranked = [...byMove.entries()].sort(([a, x], [b, y]) =>
    x.micros > y.micros ? -1 : x.micros < y.micros ? 1 : a < b ? -1 : 1,
  );
  const names = ranked.map(([move]) => move);
  const text =
    names.length <= 2
      ? names.join(" and ")
      : `${names.slice(0, 2).join(", ")}, and ${plural(names.length - 2, "more model", "more models")}`;
  return { text, lighter: ranked[0]?.[1].lighter ?? null };
}

/**
 * Builds the detector against a price book. The registered detector reads
 * the in-code list book. A caller that holds an organization's book passes
 * it here, with the words that name its prices in the finding.
 */
export function modelClassFitWith(
  book: () => PriceBook,
  prices = "list prices",
): Detector {
  return {
    kinds: ["model_class_fit"],
    counting: null,
    detect: (input, ctx) => detectWith(book(), input, ctx),
    prose: (group, evidence) => {
      const measured = BigInt(evidence.measuredMicros);
      const saving = measured - BigInt(evidence.counterfactualMicros);
      const percent =
        measured > 0n ? divideHalfEven(saving * 100n, measured) : 0n;
      const { text, lighter } = moves(group);
      const runs = group.runs.size;
      return {
        why: `${plural(runs, "run", "runs")} changed no file. Repriced from ${text} at ${prices}, ${runs === 1 ? "it" : "they"} would have cost an estimated ${percent}% less.`,
        fix: `Route tasks that only read to ${lighter ?? "a smaller model class"} with a model-route steering record, or lower their effort. Replay a sample on the smaller class to confirm the estimate before you move them.`,
      };
    },
  };
}

export const modelClassFit: Detector = modelClassFitWith(inCodeListBook);
