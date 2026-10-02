/**
 * Model class fit (detector 4, ADR-208): the steps of a run that only read,
 * repriced as if the next smaller model class of the same vendor had run
 * them. The saving is an estimate, so every figure carries the `estimated`
 * basis until a replay on the smaller class confirms it. It claims no frame
 * and stays out of the unproductive spend headline (counting rule 2).
 *
 * A run counts when it sealed before the pass's end and started at or after
 * the tool-call window, the pass read as many of its calls as the rollup
 * counted, and it made at least one tool call. A run with a spin loop is left
 * out, so detector 1 keeps its spend.
 *
 * Each step is classed by ../step-grade.ts (F17). Here a step is one model
 * call with the tool calls it made (./requests.ts). It is read-only when the
 * classifier marked each of its calls as one that changes nothing. A call the
 * classifier said nothing about may have written, so its step is an edit.
 *
 * - A run with no edit, whose calls all change nothing and which changed no
 *   file, is priced whole, as it was before steps had a class. The measured
 *   side is what the rollup priced for each model the run used.
 * - A run with an edit is priced on its read-only model calls alone: each
 *   frame's own priced cost. The pass must have read the run's frames, and
 *   each call that may write must follow a frame, or the run is left out.
 * - A run that changed a file while every call says it changed nothing is left
 *   out. The record keeps file changes per run, so no step can hold the change.
 *
 * The counterfactual swaps each model that has a smaller class for that
 * class's model at list price, and keeps every other model at its measured
 * cost. Cited at the run's agent, or at its operator when it names no agent.
 *
 * A cache keep-alive the proxy sent while the run waited (lane F32) is left
 * out of both sides. It held one model's prompt cache, and a cache belongs to
 * one model, so no lighter model could have read it.
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
  type TokenCounts,
} from "../cost-rollup";
import {
  COLD_BOOK_EFFECTIVE_FROM,
  resolvePriceEntry,
  type PriceBook,
} from "../price-book";
import { inCodeCardPrices, seedsFromPublishedPrices } from "../price-sources";
import { stepClassOf } from "../step-grade";
import type { RunView } from "./requests";
import { spinCalls } from "./spin-loops";
import {
  agentOrOperator,
  plural,
  type DetectContext,
  type Detector,
  type DetectInput,
  type Group,
  type Measure,
  type PricedRequestFrame,
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

/** A model as a breakdown or a frame names it. */
type ModelName = Pick<ModelBreakdown, "model" | "provider">;

/** The vendor a model breakdown names, or the one its id starts with. */
function vendorOf(m: ModelName): string | null {
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
export function lighterModel(m: ModelName): string | null {
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

/**
 * Tokens at one model's prices at one instant, scaled by a million. Null when
 * the book has no price for a class the tokens hold.
 */
function scaledAt(
  book: PriceBook,
  orgId: string,
  tokens: TokenCounts,
  modelId: string,
  at: Date,
): bigint | null {
  const entries: ResolvedClassEntries = {};
  for (const c of classesToResolve(tokens))
    entries[c] = resolvePriceEntry(book, {
      orgId,
      modelId,
      tokenClass: c,
      at,
    });
  const priced = priceClasses(entries, tokens);
  if (priced.missedClasses.length > 0) return null;
  return priced.scaled;
}

/** One model's tokens at another model's prices; null when a class has no price. */
function repriceAt(
  book: PriceBook,
  run: RunTotalsRecord,
  m: ModelBreakdown,
  modelId: string,
): bigint | null {
  const scaled = scaledAt(book, run.orgId, m.tokens, modelId, run.startedAt);
  return scaled === null ? null : divideHalfEven(scaled, MILLION);
}

/** Every token in a count; a server tool request counts requests, so it is left out. */
function tokenSum(counts: TokenCounts): number {
  const { server_tool_request: _requests, ...tokens } = counts;
  return Object.values(tokens).reduce((sum, n) => sum + n, 0);
}

/** Every token the run carried, less its cache keep-alives' (lane F32). */
function runTokens(run: RunTotalsRecord): number {
  let tokens = tokenSum(run.tokens);
  for (const m of run.breakdown.models)
    if (m.keepAlive !== undefined) tokens -= tokenSum(m.keepAlive.tokens);
  return tokens;
}

/**
 * A model's breakdown less its cache keep-alives (lane F32): the tokens and
 * the cost of the calls the agent made. Null when a keep-alive went unpriced,
 * so its share of the cost cannot be taken out.
 */
function withoutKeepAlives(m: ModelBreakdown): ModelBreakdown | null {
  const kept = m.keepAlive;
  if (kept === undefined) return m;
  if (kept.costMicros === null || m.costMicros === null) return null;
  const tokens = { ...m.tokens };
  for (const c of Object.keys(tokens) as (keyof TokenCounts)[])
    tokens[c] = Math.max(0, tokens[c] - kept.tokens[c]);
  const { keepAlive: _kept, ...rest } = m;
  return { ...rest, tokens, costMicros: m.costMicros - kept.costMicros };
}

/**
 * The run's measured cost against its cost with each model moved down one
 * class. Not covered when the rollup could not price the run in full, or the
 * book has no price for a class the smaller model would have billed.
 */
export function measureRun(book: PriceBook, run: RunTotalsRecord): Measure {
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
  for (const model of run.breakdown.models) {
    const m = withoutKeepAlives(model);
    if (m === null) return uncovered;
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

/**
 * The read-only model calls of a run, measured against the same calls with
 * each model moved down one class. The measured side is each frame's own
 * priced cost. Not covered when the run's cost is an estimate, a frame has no
 * price, a frame names no model or tokens by class, or the book has no price
 * for a class the smaller model would have billed.
 */
export function measureSteps(
  book: PriceBook,
  run: RunTotalsRecord,
  frames: readonly PricedRequestFrame[],
): Measure {
  const tokens = frames.reduce((sum, f) => sum + f.tokens, 0);
  const uncovered: Measure = {
    measuredTokens: tokens,
    counterfactualTokens: tokens,
    micros: null,
    basis: "estimated",
  };
  if (run.costBasis === null || run.costBasis === "estimated") return uncovered;
  let measured = 0n;
  let counterfactual = 0n;
  for (const f of frames) {
    if (f.costMicros === null || f.basis === null || f.basis === "estimated")
      return uncovered;
    if (f.model === undefined || f.classTokens === undefined) return uncovered;
    measured += f.costMicros;
    const lighter = lighterModel({
      model: f.model,
      provider: f.provider ?? null,
    });
    if (lighter === null) {
      counterfactual += f.costMicros * MILLION;
      continue;
    }
    const scaled = scaledAt(book, run.orgId, f.classTokens, lighter, f.at);
    if (scaled === null) return uncovered;
    counterfactual += scaled;
  }
  return {
    ...uncovered,
    micros: {
      measured,
      counterfactual: divideHalfEven(counterfactual, MILLION),
    },
  };
}

/**
 * The model calls of a run whose steps only read: every frame the pass read
 * for the run except those that made a call that may write, and its cache
 * keep-alives. A frame that made no tool call is read-only. Null when the
 * pass read no frame for the run, or when a call that may write came before
 * the run's first frame read, since no frame can hold that edit.
 */
export function readOnlyFrames(
  view: RunView,
  frames: readonly PricedRequestFrame[] | undefined,
): PricedRequestFrame[] | null {
  if (frames === undefined || view.requests === null) return null;
  const edits = new Set<PricedRequestFrame>();
  for (const request of view.requests) {
    const cls = stepClassOf({
      calls: request.calls.map((c) => c.call),
      changedFile: false,
    });
    if (cls === "read_only") continue;
    if (request.frame === null) return null;
    edits.add(request.frame);
  }
  // A cache keep-alive made no tool call, so it reads as read-only. It only
  // held one model's cache, which no lighter model could read (lane F32).
  return frames.filter((f) => !edits.has(f) && f.cacheKeepAlive !== true);
}

/** What a cited run's figure covers: the whole run, or its read-only steps. */
interface RunPart {
  /** True when the run made an edit, so only its read-only steps are priced. */
  edited: boolean;
  /** Each priced model's measured cost, for the moves the prose names. */
  models: readonly { model: string; provider: string | null; micros: bigint }[];
}

/**
 * The part of each run a pass priced, keyed by the run record the groups
 * hold. The prose reads it after the detector runs in the same pass.
 */
const parts = new WeakMap<RunTotalsRecord, RunPart>();

/** The measured cost of each model the frames name. */
function frameModels(frames: readonly PricedRequestFrame[]): RunPart["models"] {
  const byModel = new Map<
    string,
    { provider: string | null; micros: bigint }
  >();
  for (const f of frames) {
    if (f.model === undefined) continue;
    const seen = byModel.get(f.model) ?? {
      provider: f.provider ?? null,
      micros: 0n,
    };
    seen.micros += f.costMicros ?? 0n;
    byModel.set(f.model, seen);
  }
  return [...byModel].map(([model, m]) => ({ model, ...m }));
}

function detectWith(
  book: PriceBook,
  input: DetectInput,
  ctx: DetectContext,
): void {
  for (const view of ctx.views) {
    const { run } = view;
    // A run still going may write later. The pass read calls before its end
    // and from the tool-call window on, so a run sealed at or after the end,
    // or started before the window, may have written in a call it never read.
    if (run.sealedAt === null) continue;
    if (run.sealedAt.getTime() >= input.window.end.getTime()) continue;
    if (run.startedAt.getTime() < input.toolWindowStart.getTime()) continue;
    // The read skips a hook call with no tool name or input digest, and the
    // rollup counts it. A run whose calls the read did not see in full is left
    // out, since the call it skipped may have written.
    if (view.calls.length !== run.toolCalls) continue;
    if (spinCalls(view.calls).size > 0) continue;
    const edited = view.calls.some((c) => c.call.isMutating !== false);
    // A file change that no call may have made has no step to hold it.
    if (!edited && input.fileChanges?.get(run.runId) === true) continue;
    const key = agentOrOperator("model_class_fit", run);
    if (key === null || !ctx.groups.admits(key, run)) continue;
    if (!edited) {
      if (!run.breakdown.models.some((m) => lighterModel(m) !== null)) continue;
      parts.set(run, {
        edited: false,
        models: run.breakdown.models.map((m) => ({
          model: m.model,
          provider: m.provider,
          micros: withoutKeepAlives(m)?.costMicros ?? 0n,
        })),
      });
      // The finding is about the run's model as a whole, not a call.
      ctx.groups.add(key, input.window.start, run, measureRun(book, run), null);
      continue;
    }
    const frames = readOnlyFrames(view, input.frames?.get(run.runId));
    if (frames === null) continue;
    const models = frameModels(frames);
    if (!models.some((m) => lighterModel(m) !== null)) continue;
    parts.set(run, { edited: true, models });
    ctx.groups.add(
      key,
      input.window.start,
      run,
      measureSteps(book, run, frames),
      null,
    );
  }
}

/** Each model the group's runs moved down a class, as "from to", largest measured cost first. */
function moves(group: Group): { text: string; lighter: string | null } {
  const byMove = new Map<string, { lighter: string; micros: bigint }>();
  for (const { run } of group.runs.values()) {
    const models =
      parts.get(run)?.models ??
      run.breakdown.models.map((m) => ({ ...m, micros: m.costMicros ?? 0n }));
    for (const m of models) {
      const lighter = lighterModel(m);
      if (lighter === null) continue;
      const move = `${m.model} to ${lighter}`;
      const seen = byMove.get(move) ?? { lighter, micros: 0n };
      seen.micros += m.micros;
      byMove.set(move, seen);
    }
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
      let edited = 0;
      for (const { run } of group.runs.values())
        if (parts.get(run)?.edited === true) edited += 1;
      const whole = runs - edited;
      const target = lighter ?? "a smaller model class";
      if (edited === 0)
        return {
          why: `${plural(runs, "run", "runs")} changed no file. Repriced from ${text} at ${prices}, ${runs === 1 ? "it" : "they"} would have cost an estimated ${percent}% less.`,
          fix: `Route tasks that only read to ${target} with a model-route steering record, or lower their effort. Replay a sample on the smaller class to confirm the estimate before you move them.`,
        };
      const editedRuns = `${plural(edited, "run", "runs")} with edit steps also had steps that only read`;
      const route = `Route the steps that only read, such as searches and file reads, to a subagent on ${target} with a model-route steering record, or lower their effort.`;
      return {
        why:
          whole === 0
            ? `${editedRuns}. Repriced from ${text} at ${prices}, those steps would have cost an estimated ${percent}% less.`
            : `${plural(whole, "run", "runs")} changed no file, and ${editedRuns}. Repriced from ${text} at ${prices}, the steps that only read would have cost an estimated ${percent}% less.`,
        fix:
          whole === 0
            ? `${route} The figure stays an estimate, because a replay reruns a whole run and these runs have edit steps.`
            : `${route} Replay a sample of the runs that changed no file to confirm the estimate before you move them.`,
      };
    },
  };
}

export const modelClassFit: Detector = modelClassFitWith(inCodeListBook);
