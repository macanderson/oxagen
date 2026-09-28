/**
 * The walk that detector 3 (ADR-208) shares between its two kinds: each run's
 * model requests on one chain and one model, in time order, each beside the
 * request before it. A prompt cache belongs to one model, so a run that moves
 * between models keeps one walk per model. Cache expiry (./cache-expiry.ts)
 * and cache busts (./cache-busts.ts) read the same walk.
 *
 * A request rewrites the cache when it writes at least half its context and
 * the prefix the request before it had cached is gone: the cached tokens it
 * did not read back. The rewritten tokens are the smaller of what it wrote
 * and what it lost, so the new tokens a request adds are never priced as a
 * rewrite. A compaction between the two requests rewrites the context on
 * purpose, so the request after it is left out.
 *
 * The TTL in effect is the one the last cache write on the walk used, at or
 * before the request before. A write with any 5-minute tokens holds a
 * 5-minute tail, so the prefix expires at 5 minutes. A walk that has written
 * nothing yet reads as 5 minutes, the default. A gateway frame records no
 * 1-hour writes, so its walks read as 5 minutes.
 *
 * Only runs whose frames the store read are walked. A run past the frame
 * read cap has no frames here, and nothing shows that it rewrote a cache, so
 * neither kind cites it (ADR-210).
 */
import { divideHalfEven, type RunTotalsRecord } from "../cost-rollup";
import {
  timeOf,
  type DetectInput,
  type FrameContextPart,
  type Group,
  type PricedRequestFrame,
} from "./shared";

/** A prompt cache's time to live. */
export type CacheTtl = "5m" | "1h";

const MINUTE_MICROS = 60_000_000;
const MILLION = 1_000_000n;

/** Each TTL in microseconds. */
export const TTL_MICROS: Readonly<Record<CacheTtl, number>> = {
  "5m": 5 * MINUTE_MICROS,
  "1h": 60 * MINUTE_MICROS,
};

/**
 * How often a keep-alive reads the prefix to hold it: 4.5 minutes on the
 * 5-minute TTL, as the spec prices it, and the same 90% of the TTL, 54
 * minutes, on the 1-hour TTL.
 */
export const KEEP_ALIVE_MICROS: Readonly<Record<CacheTtl, number>> = {
  "5m": 4.5 * MINUTE_MICROS,
  "1h": 54 * MINUTE_MICROS,
};

/** One request of a walk, beside the request before it. */
export interface CacheStep {
  run: RunTotalsRecord;
  frame: PricedRequestFrame;
  /** The request before it on its chain and model; null for the walk's first. */
  prev: PricedRequestFrame | null;
  /** The TTL of the prefix `prev` left cached. */
  ttl: CacheTtl;
  /** Microseconds since `prev`; 0 for the walk's first. */
  gapMicros: number;
  /** The tokens `prev` left cached: what it read and what it wrote. */
  cached: number;
  /** The cached tokens this request wrote again; 0 when it rewrote nothing. */
  rewritten: number;
  /** The tokens of `cached` this request read back. */
  readBack: number;
}

/** A frame's tokens by class; the store sets them on every frame it reads. */
function tokensOf(f: PricedRequestFrame) {
  return f.classTokens ?? null;
}

/** Whether a compaction on the chain fell after `from` and at or before `to`. */
function compactedBetween(
  input: DetectInput,
  runId: string,
  chain: string,
  from: number,
  to: number,
): boolean {
  const list = input.compactions?.get(runId);
  if (list === undefined) return false;
  return list.some(
    (c) =>
      (c.sessionUuid ?? "") === chain && timeOf(c) > from && timeOf(c) <= to,
  );
}

/** One run's walks, flattened, each walk in time order. */
function walkRun(
  input: DetectInput,
  run: RunTotalsRecord,
  frames: readonly PricedRequestFrame[],
): CacheStep[] {
  const walks = new Map<
    string,
    { chain: string; frames: PricedRequestFrame[] }
  >();
  for (const f of frames) {
    if (tokensOf(f) === null) continue;
    const chain = f.sessionUuid ?? "";
    const key = `${chain}\u0000${f.model ?? ""}`;
    const walk = walks.get(key) ?? { chain, frames: [] };
    walk.frames.push(f);
    walks.set(key, walk);
  }
  const out: CacheStep[] = [];
  for (const { chain, frames: list } of walks.values()) {
    list.sort((a, b) => timeOf(a) - timeOf(b));
    let prev: PricedRequestFrame | null = null;
    let ttl: CacheTtl = "5m";
    for (const f of list) {
      const t = tokensOf(f)!;
      const written = t.cache_write_5m + t.cache_write_1h;
      let cached = 0;
      let gapMicros = 0;
      let rewritten = 0;
      let readBack = 0;
      if (prev !== null) {
        const p = tokensOf(prev)!;
        cached = p.cache_read + p.cache_write_5m + p.cache_write_1h;
        gapMicros = timeOf(f) - timeOf(prev);
        readBack = Math.min(t.cache_read, cached);
        const context =
          t.input_uncached + t.cache_read + t.cache_write_5m + t.cache_write_1h;
        const lost = cached - t.cache_read;
        if (
          written > 0 &&
          written * 2 >= context &&
          lost > 0 &&
          !compactedBetween(input, run.runId, chain, timeOf(prev), timeOf(f))
        )
          rewritten = Math.min(written, lost);
      }
      out.push({
        run,
        frame: f,
        prev,
        ttl,
        gapMicros,
        cached,
        rewritten,
        readBack,
      });
      if (t.cache_write_5m > 0) ttl = "5m";
      else if (t.cache_write_1h > 0) ttl = "1h";
      prev = f;
    }
  }
  return out;
}

const walked = new WeakMap<DetectInput, readonly CacheStep[]>();

/**
 * Every run's steps, walked once per pass. Both kinds of detector 3 read the
 * same input object, so the second reads the first one's walk.
 */
export function cacheSteps(input: DetectInput): readonly CacheStep[] {
  const seen = walked.get(input);
  if (seen !== undefined) return seen;
  const out: CacheStep[] = [];
  const frames = input.frames;
  if (frames !== undefined)
    for (const run of input.runs) {
      const list = frames.get(run.runId);
      if (list === undefined || list.length === 0) continue;
      out.push(...walkRun(input, run, list));
    }
  walked.set(input, out);
  return out;
}

/** Whether the step's system context digest differs from the one before it. */
export function systemChanged(step: CacheStep): boolean {
  const a = step.prev?.systemContextDigest ?? null;
  const b = step.frame.systemContextDigest ?? null;
  return a !== null && b !== null && a !== b;
}

/** Whether a rewrite followed a gap past its TTL with the system context unchanged. */
export function isIdleRewrite(step: CacheStep): boolean {
  return (
    step.rewritten > 0 &&
    step.gapMicros > TTL_MICROS[step.ttl] &&
    !systemChanged(step)
  );
}

/** Whether a rewrite came inside the TTL, or with a changed system context. */
export function isBust(step: CacheStep): boolean {
  return step.rewritten > 0 && !isIdleRewrite(step);
}

/** A class's price at the step's frame in micros per million tokens; null when unpriced or in another currency. */
export function classPrice(
  step: CacheStep,
  cls: "cache_read" | "cache_write_5m" | "cache_write_1h",
): bigint | null {
  const price = step.frame.classPrices?.[cls] ?? null;
  if (price === null) return null;
  if (price.currency.toLowerCase() !== step.run.currency.toLowerCase())
    return null;
  return price.microsPerMillion;
}

/**
 * What the rewrite paid over reading the same tokens back, in micros: the
 * rewritten share of each write class, at its write price less the read
 * price. Null when a class the frame wrote, or the read, has no price.
 */
export function rewritePremium(step: CacheStep): bigint | null {
  const t = step.frame.classTokens;
  if (t === undefined || step.rewritten === 0) return null;
  const written = t.cache_write_5m + t.cache_write_1h;
  const read = classPrice(step, "cache_read");
  if (read === null) return null;
  let perMillion = 0n;
  if (t.cache_write_5m > 0) {
    const p = classPrice(step, "cache_write_5m");
    if (p === null) return null;
    perMillion += BigInt(t.cache_write_5m) * (p - read);
  }
  if (t.cache_write_1h > 0) {
    const p = classPrice(step, "cache_write_1h");
    if (p === null) return null;
    perMillion += BigInt(t.cache_write_1h) * (p - read);
  }
  return divideHalfEven(
    perMillion * BigInt(step.rewritten),
    BigInt(written) * MILLION,
  );
}

/** How many keep-alive reads a gap takes: one per interval, as the spec counts them. */
export function keepAlivePings(step: CacheStep): number {
  return Math.floor(step.gapMicros / KEEP_ALIVE_MICROS[step.ttl]);
}

/** What the keep-alive reads over the gap would have cost, in micros; null when the read is unpriced. */
export function keepAliveCost(step: CacheStep): bigint | null {
  const read = classPrice(step, "cache_read");
  if (read === null) return null;
  return divideHalfEven(
    BigInt(keepAlivePings(step)) * BigInt(step.rewritten) * read,
    MILLION,
  );
}

/** Tokens times a price in micros per million tokens, as micros. */
export function perMillion(tokens: number, price: bigint): bigint {
  return divideHalfEven(BigInt(tokens) * price, MILLION);
}

const KIND_WORDS: Readonly<Record<FrameContextPart["kind"], string>> = {
  system: "system block",
  tool: "tool",
  steering: "steering record",
  context: "context frame",
};

/** The words for a part of the system context, such as "tool Bash". */
export function partLabel(part: FrameContextPart): string {
  return `${KIND_WORDS[part.kind]} ${part.name}`;
}

/** Where a bust's prefix changed when the system context stayed the same. */
export const AFTER_SYSTEM_CONTEXT = "the messages after the system context";
/** Where a bust's prefix changed when the digests differ and no part list names the change. */
export const SYSTEM_CONTEXT = "the system context";

function samePart(a: FrameContextPart, b: FrameContextPart): boolean {
  return a.kind === b.kind && a.name === b.name;
}

/**
 * The first part of the system context that changed between the request
 * before and this one, by comparing their parts' digests in request order.
 * The first difference is where the cached prefix broke. A part that is new
 * is named over one that moved, and a part that is gone is named when
 * nothing took its place. Null when either request recorded no digest.
 */
export function changedPart(
  prev: PricedRequestFrame,
  frame: PricedRequestFrame,
): string | null {
  const a = prev.systemContextDigest ?? null;
  const b = frame.systemContextDigest ?? null;
  if (a === null || b === null) return null;
  if (a === b) return AFTER_SYSTEM_CONTEXT;
  const before = prev.systemContextParts ?? null;
  const after = frame.systemContextParts ?? null;
  if (before === null || after === null) return SYSTEM_CONTEXT;
  const n = Math.max(before.length, after.length);
  for (let i = 0; i < n; i += 1) {
    const x = before[i];
    const y = after[i];
    if (
      x !== undefined &&
      y !== undefined &&
      samePart(x, y) &&
      x.digest === y.digest
    )
      continue;
    if (y !== undefined && !before.some((p) => samePart(p, y)))
      return partLabel(y);
    if (x !== undefined && !after.some((p) => samePart(p, x)))
      return partLabel(x);
    return partLabel((y ?? x)!);
  }
  return SYSTEM_CONTEXT;
}

/**
 * The currency a finding's prose prints: its first cited run's. A price in
 * another currency than its run's is left unpriced (`classPrice`), so the
 * sums share the run's currency.
 */
export function currencyOf(group: Group): string {
  for (const acc of group.runs.values()) return acc.run.currency;
  return "USD";
}

/** Micros as money in the finding's currency, to the cent: "$1.24". */
export function formatMicros(micros: bigint, currency: string): string {
  const units = Number(micros) / 1_000_000;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(units);
  } catch {
    return `${units.toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** A gap in whole minutes, rounded. */
export function gapMinutes(micros: number): number {
  return Math.round(micros / MINUTE_MICROS);
}
