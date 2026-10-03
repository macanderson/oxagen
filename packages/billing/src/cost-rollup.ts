/**
 * cost-rollup.ts — the PURE rollup from a run's frames to its `cost.run_totals`
 * row, and from run rows to `cost.daily_totals` (Mission Control spec §12.3,
 * §12.6, §12.7; ADR-060 §3). No I/O: the store (./cost-rollup-store.ts) reads
 * the frames and writes the rows, and this module is what the tests exercise.
 *
 * Money is integer micro-USD throughout. A frame's cost is
 * `units × micros_per_million` summed over its token classes, kept as that
 * exact product (a million times the micro figure) until the run is summed,
 * so per-frame cost is computed at full precision and rounded once, half to
 * even, to whole micros. Cents are rounded once more at the statement line
 * ({@link microsToCentsHalfEven}), never here.
 *
 * Every figure says who observed it. A gateway-priced frame is
 * `gateway_observed`, a harness-reported one `client_attested`; a run whose
 * frames differ is `mixed`. A frame whose model no price entry prices is
 * `estimated`: it contributes the cost its own record carries, or the classes
 * the book could price, and the run inherits the label. A frame the book
 * prices nothing of and whose record carries no figure is unpriced: it has
 * no cost and no basis, and a run or model group with no priced frame has
 * none either, never a zero.
 */
import {
  UNASSIGNED_COST_CENTER_KEY,
  type CostBasis,
  type SpendGroupKind,
} from "@oxagen/database/schema";
import type { WindowComposition } from "@oxagen/run-ledger";
import {
  classesToResolve,
  FRAME_TOKEN_CLASSES,
  priceClasses,
  type FrameTokenClass,
  type ResolvedClassEntries,
} from "./class-cost";
import {
  resolvePriceEntry,
  type PriceBook,
  type PriceTokenClass,
} from "./price-book";
import {
  classifySteps,
  RepeatedCalls,
  repeatKindOf,
  stepRequestsOf,
  type StepClasses,
  type StepModelCall,
  type StepToolCall,
} from "./step-grade";

export type { CostBasis, SpendGroupKind } from "@oxagen/database/schema";
export { UNASSIGNED_COST_CENTER_KEY } from "@oxagen/database/schema";

/** The token classes a model-call frame carries (spec §12.6). */
const TOKEN_CLASSES = FRAME_TOKEN_CLASSES;
type TokenClass = FrameTokenClass;
export type TokenCounts = Record<TokenClass, number>;

export const ZERO_TOKENS: TokenCounts = {
  input_uncached: 0,
  cache_read: 0,
  cache_write_5m: 0,
  cache_write_1h: 0,
  output: 0,
  reasoning: 0,
  server_tool_request: 0,
};

/** Who observed a single frame. */
/**
 * `estimated` is a frame a backfill rebuilt from a transcript (ADR-161). The
 * book still prices it at the frame's instant, and the run's cost reads
 * estimated whatever the book priced.
 */
type FrameBasis = "gateway_observed" | "client_attested" | "estimated";

/** One model call, normalized from either frame store. */
export interface ModelCallFrame {
  at: Date;
  model: string;
  provider: string | null;
  tokens: TokenCounts;
  /** The micro-USD the frame's own record carries; null when it carries none. */
  reportedCostMicros: bigint | null;
  basis: FrameBasis;
  /**
   * The chain the call was recorded on (`session_uuid`), which places the
   * tool calls it made (F17). Absent when the store names no chain.
   */
  sessionUuid?: string | null;
  /**
   * The model proxy sent this call as a cache keep-alive while a parent run
   * waited on a subagent (lane F32). Its cost and tokens count like any
   * call's. It is no step the agent took, so it counts in no step figure.
   */
  cacheKeepAlive?: boolean;
}

/**
 * One tool call; `name` is null when the frame hides it (an encrypted payload).
 *
 * The members after `name` grade the call (./step-grade.ts, ADR-199) and price
 * its result. Each is null where the frame recorded none.
 */
export interface ToolCallFrame {
  name: string | null;
  /** A store-computed repeat flag avoids retaining every prior digest. */
  repeated?: boolean;
  /** Null for a call that was cancelled, or whose frame recorded no status. */
  status: "ok" | "error" | "rejected" | null;
  inputDigest: string | null;
  outputDigest: string | null;
  /** The classifier's flag; null when it said nothing. */
  isMutating: boolean | null;
  /**
   * The call's result tokens: the count Claude Code's OTel tool span
   * reported, else the recorder's estimate from the size of the result the
   * hook saw (#5339).
   */
  resultTokens: number | null;
  /**
   * `estimated` when `resultTokens` is the recorder's estimate. Absent for a
   * count Claude Code reported, the only kind of count before #5339.
   */
  resultTokensBasis?: "estimated";
  /**
   * When the call ran (RFC 3339) and the chain it ran on, which place it
   * under the model call that made it (F17). Absent or null when the store
   * read neither.
   */
  at?: string | null;
  sessionUuid?: string | null;
}

/** What the run's own record says, independent of its frames. */
export interface RunMeta {
  runId: string;
  runSource: "ledger" | "tacho";
  orgId: string;
  workspaceId: string;
  operatorPrincipalId: string | null;
  /** The operator's principal public id (`prn_…`): the key of its `operator` group, the id `list_runs` answers. */
  operatorKey: string | null;
  agentPrincipalId: string | null;
  agentKey: string | null;
  taskRef: string | null;
  /**
   * The cost-center label the run is charged back to: the agent's live label,
   * else the workspace's, else null (unassigned). Resolved by the store.
   */
  costCenter: string | null;
  startedAt: Date;
  sealedAt: Date | null;
  /** Null when the frames hide the turn index. */
  turns: number | null;
  retries: number | null;
  enforcementTier: "contained" | "gateway" | "harness" | "observe" | null;
  replayGrade: "inspect" | "view" | "fork" | "retry" | null;
  /**
   * The run's parent work order (F13, #4638): a send's `work.orders` id or a
   * direct work order's `work.direct_orders` id, as `workOrderKind` says.
   * The store resolves it (./run-work-order.ts). Absent or null when the
   * rollup resolved none.
   */
  workOrderId?: string | null;
  workOrderKind?: "send" | "direct" | null;
}

export interface ModelBreakdown {
  model: string;
  provider: string | null;
  calls: number;
  tokens: TokenCounts;
  /**
   * The priced calls' total; non-null whenever at least one call priced,
   * even when another call to this same model did not. A group with a
   * mixed priced/unpriced history is still `costMicros !== null`, so a scan
   * for incomplete cost reads {@link ModelBreakdown.hasUnpriced}, not this.
   */
  costMicros: bigint | null;
  /** The same cost split by token class, each rounded once; a class the book priced nothing for is 0. */
  costByClass: Record<TokenClass, bigint>;
  /**
   * What this model's cache reads saved, rounded once like
   * {@link ModelBreakdown.costByClass}: each frame's cache_read tokens priced
   * at its instant's input_uncached rate less its cache_read rate. 0 when no
   * frame read the cache. Null when any frame that read the cache had no
   * entry for either rate, and on a row rolled up before this field existed.
   */
  cacheSavingMicros: bigint | null;
  basis: CostBasis | null;
  /**
   * True when any call to this model in the run went unpriced — including a
   * group where some other call to the same model DID price, which leaves
   * {@link ModelBreakdown.costMicros} non-null. `rollupRun` aggregates by
   * model, not by call, so this is the only place a mixed group's gap
   * survives; a later reprice scan that read `costMicros === null` alone
   * would never revisit a run whose only gap is one call inside an
   * otherwise-priced model group (#3271 residue G2).
   */
  hasUnpriced: boolean;
  /**
   * The tokens of the calls the rollup priced, by class: {@link tokens} less
   * the unpriced calls'. A rate divides a class's cost by these, since the
   * cost counts only the priced calls (#4572). Absent on a row rolled up
   * before they were kept.
   */
  pricedTokens?: TokenCounts;
  /**
   * The cache keep-alives the model proxy sent on this model (lane F32), a
   * part of {@link tokens} and {@link costMicros}. They are not in
   * {@link calls}, which counts the calls the agent made. Absent when the
   * run sent none, and on a row rolled up before keep-alives were kept
   * apart. `costMicros` is null when a keep-alive went unpriced.
   */
  keepAlive?: KeepAliveBreakdown;
}

/** One model's cache keep-alives within a run (lane F32). */
export interface KeepAliveBreakdown {
  calls: number;
  tokens: TokenCounts;
  costMicros: bigint | null;
}

/**
 * One tool's calls in the run (#3892, ADR-199). A row stored before the
 * result tokens were recorded revives with both figures null. `costMicros` is
 * serialized as a decimal string in the jsonb.
 */
export interface ToolBreakdown {
  name: string;
  calls: number;
  /** The tool-result tokens its calls recorded, summed; null when none did. */
  resultTokens: number | null;
  /**
   * `estimated` when any call's count in `resultTokens` was the recorder's
   * estimate rather than Claude Code's report (#5339), the way an estimated
   * part makes a cost basis `estimated` (`foldBasis`). Absent when every
   * count was reported, which is every row rolled up before #5339, and when
   * `resultTokens` is null.
   */
  resultTokensBasis?: "estimated";
  /**
   * `resultTokens` priced at the run's uncached input rate
   * ({@link runInputPrice}). It estimates input the run's own cost already
   * counts, and never adds to it. Null when `resultTokens` is null or the run
   * has no input price.
   */
  costMicros: bigint | null;
}

/** Why the unproductive steps made no progress; the three sum to `unproductiveSteps`. */
export interface StepCauses {
  failed: number;
  repeated: number;
  retried: number;
}

export interface RunBreakdown {
  models: ModelBreakdown[];
  tools: ToolBreakdown[];
  /**
   * The unproductive steps by cause (#3984, ADR-199), stored in the jsonb with
   * no column. Null exactly when the run's steps are not graded: a run with no
   * step, and a row rolled up before grading existed, which revives as null.
   */
  steps: StepCauses | null;
  /**
   * Every step by class (F17): `readOnly` when none of its calls may write
   * and no file changed, `edit` otherwise. The two sum to the run's steps.
   * Null for a run with no step, and absent on a row rolled up before steps
   * had a class.
   */
  stepClasses?: StepClasses | null;
  /**
   * Each standing context source's re-sent tokens on the run's model calls,
   * split by whether the call read the prompt cache (#4572). A call re-sent a
   * source only up to what the last call that carried it sent (#5339;
   * `createStandingSplit`). The store measures it on the frames beside the
   * source sums, and it is null for a source no call reported. Absent on a
   * row rolled up before it was kept. A row rolled up before #5339 counted
   * every call after the run's first as re-sending its whole count.
   */
  standing?: RunStandingResent;
  /**
   * The run's prompt composition: each window block's tokens summed over
   * every request window the run recorded (`windowComposition` in
   * `@oxagen/run-ledger`, #5341). It is the only record of a run's
   * conversation and system tokens. The store reads it from the frames when
   * the run has sealed, and a rollup of an open run carries the one its row
   * already has. Null when no window reported a prompt total, or
   * when the read stopped at its cap, so a prefix is never stored as the
   * whole. Absent on a row rolled up before it was kept. A reader takes null
   * and absent alike as not measured, never as zero.
   */
  windows?: WindowComposition | null;
}

/** One standing context source's re-sent tokens over a run's model calls. */
export interface ResentSourceTokens {
  /** On the calls that read anything from the prompt cache. */
  cached: number;
  /** On the calls that read nothing from it, which sent the prefix uncached. */
  uncached: number;
}

/** The three standing context sources the recorder measures, re-sent. */
export interface RunStandingResent {
  toolDefinitionTokens: ResentSourceTokens | null;
  contextFrameTokens: ResentSourceTokens | null;
  steeringTokens: ResentSourceTokens | null;
}

/** The `cost.run_totals` row, as the store writes it. */
export interface RunTotalsRecord extends RunMeta {
  steps: number;
  modelCalls: number;
  toolCalls: number;
  tokens: TokenCounts;
  costMicros: bigint | null;
  currency: string;
  costBasis: CostBasis | null;
  priceEntryIds: string[];
  cacheHitRate: number | null;
  breakdown: RunBreakdown;
  /** The witness verdict (ADR-064), rebuilt with the row. */
  verdict: string | null;
  /** A person's acceptance: a column another lane writes, which the rollup carries. */
  accepted: boolean | null;
  /** `advancedSteps / steps`; null exactly when the steps are not graded. */
  productiveRatio: number | null;
  /**
   * The steps that advanced the run and the steps that did not (#3984,
   * ADR-199): null together, and summing to `steps` when set.
   */
  advancedSteps: number | null;
  unproductiveSteps: number | null;
}

const MILLION = 1_000_000n;
const USD = "USD";

// ── Arithmetic ────────────────────────────────────────────────────────────────

/** `numerator ÷ denominator` rounded half to even; `denominator` > 0. */
export function divideHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("denominator must be positive");
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  const quotient = n / denominator;
  const remainder = n % denominator;
  const twice = remainder * 2n;
  let rounded = quotient;
  if (twice > denominator || (twice === denominator && quotient % 2n === 1n))
    rounded = quotient + 1n;
  return negative ? -rounded : rounded;
}

/** Whole cents from micro-USD, rounded half to even: the statement line (spec §12.3). */
export function microsToCentsHalfEven(micros: bigint): bigint {
  return divideHalfEven(micros, 10_000n);
}

/**
 * Fold two bases into the run's: equal stays, different is `mixed`, and an
 * `estimated` figure on either side makes the whole `estimated`, since a
 * total that contains a guess is a guess whoever observed the rest.
 */
export function foldBasis(
  current: CostBasis | null,
  next: CostBasis,
): CostBasis {
  if (current === null || current === next) return next;
  if (current === "estimated" || next === "estimated") return "estimated";
  return "mixed";
}

function addTokens(into: TokenCounts, from: TokenCounts): void {
  for (const c of TOKEN_CLASSES) into[c] += from[c];
}

/** The price-book class a frame class is priced under. */
const PRICE_CLASS: Record<TokenClass, PriceTokenClass> = {
  input_uncached: "input_uncached",
  cache_read: "cache_read",
  cache_write_5m: "cache_write_5m",
  cache_write_1h: "cache_write_1h",
  output: "output",
  reasoning: "reasoning",
  server_tool_request: "server_tool_request",
};

interface PricedFrame {
  /** A million times the frame's micro-USD; null when the frame is unpriced. */
  scaled: bigint | null;
  /** The same, by token class; an estimated frame's reported figure sits under `output`. */
  scaledByClass: Record<TokenClass, bigint>;
  basis: CostBasis | null;
  priceEntryIds: string[];
  /**
   * A million times the micro-USD the frame's cache reads saved, priced from
   * the book whatever the frame's own cost came from; 0n with no cache reads,
   * null when a rate the saving needs is missing.
   */
  cacheSavingScaled: bigint | null;
}

const zeroScaled = (): Record<TokenClass, bigint> => ({
  input_uncached: 0n,
  cache_read: 0n,
  cache_write_5m: 0n,
  cache_write_1h: 0n,
  output: 0n,
  reasoning: 0n,
  server_tool_request: 0n,
});

/**
 * Price one frame against the book. Every class with units resolves its own
 * entry at the frame's instant; a class no entry prices makes the frame
 * `estimated`, and the frame then contributes what its own record reported
 * (the harness's or the gateway's figure), or the classes the book priced
 * when it reported nothing. A frame with no priced class and no reported
 * figure is unpriced: `scaled` and `basis` are null.
 */
export function priceFrame(
  book: PriceBook,
  orgId: string,
  frame: ModelCallFrame,
): PricedFrame {
  const entries: ResolvedClassEntries = {};
  for (const c of classesToResolve(frame.tokens))
    entries[c] = resolvePriceEntry(book, {
      orgId,
      modelId: frame.model,
      tokenClass: PRICE_CLASS[c],
      at: frame.at,
    });
  const priced = priceClasses(entries, frame.tokens);
  const missed = priced.missedClasses.length > 0;
  const ids = priced.priceEntryIds;
  const cacheSavingScaled = priced.cacheSavingScaled;
  if (missed && frame.reportedCostMicros !== null) {
    // The reported figure is one number with no split; it sits under output.
    const reported = frame.reportedCostMicros * MILLION;
    return {
      scaled: reported,
      scaledByClass: { ...zeroScaled(), output: reported },
      basis: "estimated",
      priceEntryIds: ids,
      cacheSavingScaled,
    };
  }
  if (missed && ids.length === 0)
    return {
      scaled: null,
      scaledByClass: zeroScaled(),
      basis: null,
      priceEntryIds: [],
      cacheSavingScaled,
    };
  return {
    scaled: priced.scaled,
    scaledByClass: priced.scaledByClass,
    basis: missed ? "estimated" : frame.basis,
    priceEntryIds: ids,
    cacheSavingScaled,
  };
}

/**
 * cache_read ÷ (input_uncached + cache_read), weighted by each frame's
 * spend; token-weighted when no frame cost anything; null when no frame
 * carried input tokens (spec §12.6: never computed from missing data as if
 * it were zero).
 *
 * Cache writes are not in the denominator, so a run that rebuilt its cache
 * can still read a high rate. The record keeps the write counts by class.
 * The Run page's Cost tab prints the share of input written to the cache
 * beside this rate (`cacheRebuildShare`), and so does the Spend page's
 * token class panel (`cacheWriteShare`, A-08). The Run stat row and the
 * Fleet tile keep one line each, so they carry the rate alone.
 */
export function cacheHitRate(
  frames: readonly { tokens: TokenCounts; scaled: bigint }[],
): number | null {
  let weighted = 0;
  let weights = 0n;
  let reads = 0;
  let inputs = 0;
  for (const f of frames) {
    const denominator = f.tokens.input_uncached + f.tokens.cache_read;
    if (denominator <= 0) continue;
    const rate = f.tokens.cache_read / denominator;
    weighted += rate * Number(f.scaled);
    weights += f.scaled;
    reads += f.tokens.cache_read;
    inputs += denominator;
  }
  if (inputs === 0) return null;
  if (weights > 0n) return weighted / Number(weights);
  return reads / inputs;
}

// ── Input price ───────────────────────────────────────────────────────────────

/** What a run paid for its input: the uncached input the rollup priced, over the tokens it carried. */
export interface InputPrice {
  micros: bigint;
  tokens: bigint;
}

/**
 * What a run paid for one uncached input token, as a ratio; null when nothing
 * priced its input. A run whose cost is `estimated`, or has none, has no
 * price: a figure built on it would be a guess priced from a guess.
 *
 * The cost counts only the calls the book priced, so the ratio divides it by
 * those calls' tokens ({@link ModelBreakdown.pricedTokens}). A row rolled up
 * before those were kept counts every call's tokens, so a model there with an
 * unpriced call would read low, and such a run has no price (#4572). A zero
 * price is a price: the book can price input at nothing.
 *
 * The findings job prices a result the run could have left out with this,
 * and the rollup prices each tool's result tokens with it (ADR-199), so the
 * two agree on what one token of the run cost.
 */
export function runInputPrice(run: {
  costBasis: CostBasis | null;
  breakdown: Pick<RunBreakdown, "models">;
}): InputPrice | null {
  if (run.costBasis === null || run.costBasis === "estimated") return null;
  let micros = 0n;
  let tokens = 0n;
  for (const m of run.breakdown.models) {
    const priced = pricedTokensOf(m, "input_uncached");
    if (priced === null) return null;
    micros += m.costByClass.input_uncached;
    tokens += BigInt(priced);
  }
  if (tokens === 0n) return null;
  return { micros, tokens };
}

/**
 * A model's tokens of one class on the calls the rollup priced. A row rolled
 * up before those were kept gives every call's tokens when no call went
 * unpriced, and null when one did and the class has tokens, since the priced
 * share is then unknown. A model whose `costMicros` is null priced nothing.
 */
export function pricedTokensOf(
  m: Pick<
    ModelBreakdown,
    "tokens" | "pricedTokens" | "hasUnpriced" | "costMicros"
  >,
  tokenClass: TokenClass,
): number | null {
  if (m.pricedTokens !== undefined) return m.pricedTokens[tokenClass];
  if (m.costMicros === null) return 0;
  if (m.hasUnpriced && m.tokens[tokenClass] > 0) return null;
  return m.tokens[tokenClass];
}

/** `tokens` at a run's input price, rounded half to even to whole micros. */
export function priceInputTokens(price: InputPrice, tokens: number): bigint {
  return divideHalfEven(BigInt(tokens) * price.micros, price.tokens);
}

// ── Run rollup ────────────────────────────────────────────────────────────────

interface RollupInput {
  meta: RunMeta;
  modelCalls: readonly ModelCallFrame[];
  toolCalls: readonly ToolCallFrame[];
  book: PriceBook;
  /**
   * The verdict the store read, and the acceptance another lane owns, carried
   * through from the existing row. The productive ratio is not carried: the
   * rollup computes it from the steps it grades.
   */
  carried?: Pick<RunTotalsRecord, "verdict" | "accepted">;
  /**
   * Whether a session of the run recorded a file change, which the step
   * classes read (F17). False when the store read none.
   */
  changedFile?: boolean;
}

/** Rebuild one run's row from its frames. */
export function rollupRun(input: RollupInput): RunTotalsRecord {
  const accumulator = createRunRollup(input);
  for (const frame of input.modelCalls) accumulator.addModel(frame, input.book);
  for (const frame of input.toolCalls) accumulator.addTool(frame);
  return accumulator.finish();
}

/** Maximum distinct output groups retained by one rollup. */
export const MAX_ROLLUP_GROUPS = 4_096;
const MAX_ROLLUP_PRICE_ENTRIES = 65_536;

/**
 * Aggregate streamed frames while retaining model and tool totals, and each
 * call's time and chain for the step classes (F17).
 */
export function createRunRollup(
  input: Pick<RollupInput, "meta" | "carried" | "changedFile">,
) {
  const { meta } = input;
  const tokens: TokenCounts = { ...ZERO_TOKENS };
  const priceEntryIds = new Set<string>();
  const byModel = new Map<
    string,
    {
      provider: string | null;
      calls: number;
      tokens: TokenCounts;
      scaled: bigint | null;
      scaledByClass: Record<TokenClass, bigint>;
      /** Sticky null: one frame that read the cache and could not price the saving voids it. */
      cacheSaving: bigint | null;
      basis: CostBasis | null;
      hasUnpriced: boolean;
      /** The tokens of the frames that priced. */
      pricedTokens: TokenCounts;
      /** The model's cache keep-alives; null until the first (lane F32). */
      keepAlive: {
        calls: number;
        tokens: TokenCounts;
        scaled: bigint | null;
      } | null;
    }
  >();
  let cacheWeighted = 0;
  let cacheWeights = 0n;
  let cacheReads = 0;
  let cacheInputs = 0;
  let modelCalls = 0;
  let toolCalls = 0;
  let failed = 0;
  let repeated = 0;
  const seen = new RepeatedCalls();
  // Each call's time and chain, kept until the run ends so the step classes
  // can place each tool call under the model call that made it (F17).
  const stepModels: StepModelCall[] = [];
  const stepTools: StepToolCall[] = [];
  let scaledTotal: bigint | null = null;
  let basis: CostBasis | null = null;

  const addModel = (frame: ModelCallFrame, book: PriceBook) => {
    // A cache keep-alive the proxy sent while the agent waited (lane F32) is
    // spend and no step: it counts in the cost and the tokens, and in no
    // step, no model call, and no cache figure. Placed as a step, it took
    // the tool calls that finished after the wait.
    const keepAlive = frame.cacheKeepAlive === true;
    if (!keepAlive) {
      modelCalls += 1;
      stepModels.push(
        frame.sessionUuid === undefined
          ? { atMs: frame.at.getTime() }
          : { atMs: frame.at.getTime(), chain: frame.sessionUuid },
      );
    }
    const p = priceFrame(book, meta.orgId, frame);
    for (const id of p.priceEntryIds) {
      if (!priceEntryIds.has(id) && priceEntryIds.size >= MAX_ROLLUP_PRICE_ENTRIES)
        throw new RangeError("Run rollup exceeds the price entry limit.");
      priceEntryIds.add(id);
    }
    if (!byModel.has(frame.model) && byModel.size >= MAX_ROLLUP_GROUPS)
      throw new RangeError("Run rollup exceeds the distinct model limit.");
    addTokens(tokens, frame.tokens);
    const denominator = frame.tokens.input_uncached + frame.tokens.cache_read;
    // A keep-alive reads the whole cached prompt by design, so it would
    // raise the agent's cache hit rate for a read the agent never made.
    if (denominator > 0 && !keepAlive) {
      cacheWeighted +=
        (frame.tokens.cache_read / denominator) * Number(p.scaled ?? 0n);
      cacheWeights += p.scaled ?? 0n;
      cacheReads += frame.tokens.cache_read;
      cacheInputs += denominator;
    }
    const group = byModel.get(frame.model) ?? {
      provider: frame.provider,
      calls: 0,
      tokens: { ...ZERO_TOKENS },
      scaled: null,
      scaledByClass: zeroScaled(),
      cacheSaving: 0n,
      basis: null,
      hasUnpriced: false,
      pricedTokens: { ...ZERO_TOKENS },
      keepAlive: null,
    };
    if (keepAlive) {
      // Its read saved nothing the agent would otherwise have paid: without
      // the wait there is no keep-alive. Kept apart so a reader can take it
      // out of the model's figures.
      const kept = (group.keepAlive ??= {
        calls: 0,
        tokens: { ...ZERO_TOKENS },
        scaled: 0n,
      });
      kept.calls += 1;
      addTokens(kept.tokens, frame.tokens);
      kept.scaled =
        kept.scaled === null || p.scaled === null || p.basis === null
          ? null
          : kept.scaled + p.scaled;
    } else {
      group.calls += 1;
      // Folded before the unpriced branch below: an unpriced frame that read
      // the cache is exactly a frame whose saving nobody can price.
      group.cacheSaving =
        group.cacheSaving === null || p.cacheSavingScaled === null
          ? null
          : group.cacheSaving + p.cacheSavingScaled;
    }
    addTokens(group.tokens, frame.tokens);
    group.provider ??= frame.provider;
    byModel.set(frame.model, group);
    // An unpriced frame counts as a call and carries its tokens; it adds no
    // figure and no basis to the run or its model group, but it still marks
    // the group as incomplete even when a sibling call to the same model
    // did price (#3271 residue G2) — a later price cannot repair a run a
    // scan never revisits.
    if (p.scaled === null || p.basis === null) {
      group.hasUnpriced = true;
      return;
    }
    scaledTotal = (scaledTotal ?? 0n) + p.scaled;
    basis = foldBasis(basis, p.basis);
    addTokens(group.pricedTokens, frame.tokens);
    group.scaled = (group.scaled ?? 0n) + p.scaled;
    for (const c of TOKEN_CLASSES) group.scaledByClass[c] += p.scaledByClass[c];
    group.basis = foldBasis(group.basis, p.basis);
  };

  const byTool = new Map<
    string,
    { calls: number; resultTokens: number | null; estimated: boolean }
  >();
  const addTool = (call: ToolCallFrame) => {
    toolCalls += 1;
    const atMs =
      call.at === undefined || call.at === null ? null : Date.parse(call.at);
    stepTools.push(
      call.sessionUuid === undefined
        ? { atMs, isMutating: call.isMutating }
        : { atMs, chain: call.sessionUuid, isMutating: call.isMutating },
    );
    const repeat = call.repeated ?? (
      call.name !== null &&
      call.inputDigest !== null &&
      seen.repeats("", call.name, call.inputDigest, call.outputDigest)
    );
    if (call.status === "error" || call.status === "rejected") failed += 1;
    else if (
      repeat &&
      call.name !== null &&
      repeatKindOf({ tool: call.name, isMutating: call.isMutating }) !== null
    ) repeated += 1;
    if (call.name === null) return;
    if (!byTool.has(call.name) && byTool.size >= MAX_ROLLUP_GROUPS)
      throw new RangeError("Run rollup exceeds the distinct tool limit.");
    const tool = byTool.get(call.name) ?? {
      calls: 0,
      resultTokens: null,
      estimated: false,
    };
    tool.calls += 1;
    // A call that recorded nothing adds nothing, and a tool none of whose
    // calls recorded any stays null rather than 0. One estimated count makes
    // the tool's sum an estimate (#5339).
    if (call.resultTokens !== null) {
      tool.resultTokens = (tool.resultTokens ?? 0) + call.resultTokens;
      if (call.resultTokensBasis === "estimated") tool.estimated = true;
    }
    byTool.set(call.name, tool);
  };

  const finish = (): RunTotalsRecord => {
    const steps = modelCalls + toolCalls;
    const retried = Math.min(
      Math.max(0, Math.trunc(meta.retries ?? 0)),
      modelCalls,
    );
    const unproductive = failed + repeated + retried;
    const grade = steps === 0 ? null : {
      advanced: steps - unproductive,
      unproductive,
      causes: { failed, repeated, retried },
    };
    const costBasis = scaledTotal === null ? null : basis;
    const models: ModelBreakdown[] = [...byModel.entries()]
      .map(([model, g]) => ({
        model,
        provider: g.provider,
        calls: g.calls,
        tokens: g.tokens,
        costMicros: g.scaled === null ? null : divideHalfEven(g.scaled, MILLION),
        costByClass: Object.fromEntries(
          TOKEN_CLASSES.map((c) => [
            c,
            divideHalfEven(g.scaledByClass[c], MILLION),
          ]),
        ) as Record<TokenClass, bigint>,
        cacheSavingMicros:
          g.cacheSaving === null ? null : divideHalfEven(g.cacheSaving, MILLION),
        basis: g.scaled === null ? null : g.basis,
        hasUnpriced: g.hasUnpriced,
        pricedTokens: g.pricedTokens,
        ...(g.keepAlive === null
          ? {}
          : {
              keepAlive: {
                calls: g.keepAlive.calls,
                tokens: g.keepAlive.tokens,
                costMicros:
                  g.keepAlive.scaled === null
                    ? null
                    : divideHalfEven(g.keepAlive.scaled, MILLION),
              },
            }),
      }))
      .sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
    // Each tool's result tokens at the run's own input price (ADR-199): the
    // share of the run's input the tool's results were, never money on top of
    // it. The price reads the rounded per-model input cost, as the findings
    // job's does, so the two price one token alike.
    const price = runInputPrice({ costBasis, breakdown: { models } });
    const tools: ToolBreakdown[] = [...byTool.entries()]
      .map(([name, tool]) => ({
        name,
        calls: tool.calls,
        resultTokens: tool.resultTokens,
        ...(tool.resultTokens !== null && tool.estimated
          ? { resultTokensBasis: "estimated" as const }
          : {}),
        costMicros:
          tool.resultTokens === null || price === null
            ? null
            : priceInputTokens(price, tool.resultTokens),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return {
      ...meta,
      steps,
      modelCalls,
      toolCalls,
      tokens,
      costMicros:
        scaledTotal === null ? null : divideHalfEven(scaledTotal, MILLION),
      currency: USD,
      costBasis,
      priceEntryIds: [...priceEntryIds].sort(),
      cacheHitRate: cacheInputs === 0 ? null : cacheWeights > 0n
        ? cacheWeighted / Number(cacheWeights)
        : cacheReads / cacheInputs,
      breakdown: {
        models,
        tools,
        steps: grade === null ? null : grade.causes,
        stepClasses:
          steps === 0
            ? null
            : classifySteps({
                requests: stepRequestsOf(stepModels, stepTools),
                changedFile: input.changedFile ?? false,
              }),
      },
      verdict: input.carried?.verdict ?? null,
      accepted: input.carried?.accepted ?? null,
      productiveRatio: grade === null ? null : grade.advanced / steps,
      advancedSteps: grade === null ? null : grade.advanced,
      unproductiveSteps: grade === null ? null : grade.unproductive,
    };
  };
  return { addModel, addTool, finish };
}

// ── Daily rollup ──────────────────────────────────────────────────────────────

/** One `cost.daily_totals` row. */
export interface DailyTotalsRecord {
  orgId: string;
  workspaceId: string;
  /** `YYYY-MM-DD`, the UTC day the runs started. */
  day: string;
  groupKind: SpendGroupKind;
  groupKey: string;
  provider: string | null;
  runs: number;
  calls: number;
  costMicros: bigint | null;
  currency: string;
  costBasis: CostBasis | null;
  provenMicros: bigint | null;
  acceptedMicros: bigint | null;
  /**
   * The group's graded runs' advanced steps over their steps (ADR-199), the
   * division the agent baseline makes. Null when no run in the group is
   * graded.
   */
  productiveRatio: number | null;
  /** The steps behind `productiveRatio`, its weight when days are summed. */
  gradedSteps: number | null;
  tokens: TokenCounts;
}

/** The UTC calendar day of an instant, as `YYYY-MM-DD`. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

interface Accumulator {
  provider: string | null;
  runs: number;
  calls: number;
  cost: bigint | null;
  basis: CostBasis | null;
  proven: bigint | null;
  accepted: bigint | null;
  advancedSteps: number;
  gradedSteps: number;
  graded: boolean;
  tokens: TokenCounts;
}

function accumulator(provider: string | null): Accumulator {
  return {
    provider,
    runs: 0,
    calls: 0,
    cost: null,
    basis: null,
    proven: null,
    accepted: null,
    advancedSteps: 0,
    gradedSteps: 0,
    graded: false,
    tokens: { ...ZERO_TOKENS },
  };
}

function addCost(
  acc: Accumulator,
  cost: bigint | null,
  basis: CostBasis | null,
): void {
  if (cost === null || basis === null) return;
  acc.cost = (acc.cost ?? 0n) + cost;
  acc.basis = foldBasis(acc.basis, basis);
}

/** The value columns every group carries from the run (spec §12.8). */
function addValue(acc: Accumulator, run: RunTotalsRecord, cost: bigint | null) {
  if (run.verdict !== null) {
    acc.proven ??= 0n;
    if (run.verdict === "flipped" && cost !== null) acc.proven += cost;
  }
  if (run.accepted !== null) {
    acc.accepted ??= 0n;
    if (run.accepted && cost !== null) acc.accepted += cost;
  }
  // Steps, not runs, weight the ratio: a group's ratio is its graded runs'
  // advanced steps over their steps, as the agent baseline divides them.
  if (run.advancedSteps !== null) {
    acc.graded = true;
    acc.advancedSteps += run.advancedSteps;
    acc.gradedSteps += run.steps;
  }
}

/**
 * Fold run rows into their day's groups. Each run contributes to the
 * operator, agent and task it names (a run that names none is not attributed
 * to that level, spec §12.7), to every model its frames used, and to every
 * tool it called.
 *
 * The cost-center level departs from §12.7 on purpose (ADR-142): a run with
 * no cost center is attributed to {@link UNASSIGNED_COST_CENTER_KEY} rather
 * than left out. Chargeback divides the whole bill, so every run lands in
 * exactly one cost-center group at its full run cost and basis, the level's
 * rows sum to the same total the run rows do, and the unlabelled share is a
 * row a reader can see rather than a gap between two numbers.
 */
export function dailyTotalsFromRuns(
  runs: readonly RunTotalsRecord[],
): DailyTotalsRecord[] {
  const accumulator = createDailyRollup();
  for (const run of runs) accumulator.addRun(run);
  return accumulator.finish();
}

/** Aggregate daily totals without retaining the day's run rows. */
export function createDailyRollup() {
  const groups = new Map<string, Accumulator & DailyKey>();
  type DailyKey = {
    orgId: string;
    workspaceId: string;
    day: string;
    groupKind: SpendGroupKind;
    groupKey: string;
  };
  const get = (key: DailyKey, provider: string | null) => {
    const id = `${key.workspaceId}|${key.day}|${key.groupKind}|${key.groupKey}`;
    let acc = groups.get(id);
    if (!acc) {
      if (groups.size >= 65_536)
        throw new RangeError("Daily rollup exceeds the distinct group limit.");
      acc = { ...accumulator(provider), ...key };
      groups.set(id, acc);
    }
    return acc;
  };

  const addRun = (run: RunTotalsRecord) => {
    const day = utcDay(run.startedAt);
    const base = { orgId: run.orgId, workspaceId: run.workspaceId, day };
    const levels: [SpendGroupKind, string | null][] = [
      ["operator", run.operatorKey],
      ["agent", run.agentKey],
      ["task", run.taskRef],
      ["cost_center", run.costCenter ?? UNASSIGNED_COST_CENTER_KEY],
    ];
    for (const [groupKind, groupKey] of levels) {
      if (groupKey === null) continue;
      const acc = get({ ...base, groupKind, groupKey }, null);
      acc.runs += 1;
      acc.calls += run.steps;
      addCost(acc, run.costMicros, run.costBasis);
      addValue(acc, run, run.costMicros);
      addTokens(acc.tokens, run.tokens);
    }
    for (const m of run.breakdown.models) {
      const acc = get(
        { ...base, groupKind: "model", groupKey: m.model },
        m.provider,
      );
      acc.runs += 1;
      acc.calls += m.calls;
      addCost(acc, m.costMicros, m.basis);
      addValue(acc, run, m.costMicros);
      addTokens(acc.tokens, m.tokens);
    }
    for (const t of run.breakdown.tools) {
      const acc = get({ ...base, groupKind: "tool", groupKey: t.name }, null);
      acc.runs += 1;
      acc.calls += t.calls;
      // No frame prices a tool call (spec §12.3, "with a declared price").
      // The run row's per-tool figure is an estimate of input the run's cost
      // already counts (ADR-199), so the group's cost stays null: summed
      // here, it would count that input a second time beside the model rows.
      addValue(acc, run, null);
    }
  };

  const finish = (): DailyTotalsRecord[] => [...groups.values()].map((acc) => ({
    orgId: acc.orgId,
    workspaceId: acc.workspaceId,
    day: acc.day,
    groupKind: acc.groupKind,
    groupKey: acc.groupKey,
    provider: acc.provider,
    runs: acc.runs,
    calls: acc.calls,
    costMicros: acc.cost,
    currency: USD,
    costBasis: acc.basis,
    provenMicros: acc.proven,
    acceptedMicros: acc.accepted,
    productiveRatio:
      !acc.graded || acc.gradedSteps === 0
        ? null
        : acc.advancedSteps / acc.gradedSteps,
    gradedSteps: acc.graded ? acc.gradedSteps : null,
    tokens: acc.tokens,
  }));
  return { addRun, finish };
}
