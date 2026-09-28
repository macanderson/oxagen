/**
 * Idle cache rewrites (detector 3, ADR-208): a request that wrote its cached
 * prefix again because the wait since the request before it passed the TTL.
 * The walk and the rewrite rule are in ./cache-steps.ts. A rewrite whose
 * system context changed is a bust (./cache-busts.ts), since no keep-alive
 * would have saved it.
 *
 * Each rewrite is priced at its premium: the rewritten tokens at the write
 * price less the read price. Beside it sits what a keep-alive would have
 * cost: one read of those tokens every `KEEP_ALIVE_MICROS` through the gap.
 * The finding cites a rewrite only when the keep-alive would have cost less.
 * A longer wait is a rewrite no keep-alive pays for, so it is left out. A
 * rewrite with no price is cited uncovered when its gap is short enough that
 * a keep-alive pays at list prices (`LIST_BREAKEVEN_READS`).
 *
 * The finding also carries a TTL recommendation for its agent, set through
 * `Groups.recommend`. It weighs, across every request of the agent the pass
 * walked, what the 1-hour TTL costs more on writes against the rewrites it
 * avoids on gaps of 5 to 60 minutes, and proposes the cheaper TTL. The answer
 * may be the TTL already in effect. It prices parts of requests, so it
 * claims no frame (ADR-208, counting rule 2).
 */
import {
  cacheSteps,
  classPrice,
  currencyOf,
  formatMicros,
  gapMinutes,
  isIdleRewrite,
  keepAliveCost,
  keepAlivePings,
  perMillion,
  rewritePremium,
  TTL_MICROS,
  type CacheStep,
  type CacheTtl,
} from "./cache-steps";
import {
  agentOrOperator,
  findingFingerprint,
  plural,
  type DetectContext,
  type Detector,
  type DetectInput,
  type FindingKey,
  type FindingRecommendation,
  type Group,
  type Measure,
} from "./shared";

/**
 * The most keep-alive reads that cost less than one rewrite at list prices.
 * A 5-minute write costs 1.25 times the input price and a read 0.1 times, so
 * 11 reads cost less than the 1.15 premium. A 1-hour write costs 2 times, so
 * 18 reads cost less than the 1.9 premium.
 */
export const LIST_BREAKEVEN_READS: Readonly<Record<CacheTtl, number>> = {
  "5m": 11,
  "1h": 18,
};

/** The setting a TTL recommendation names. */
export const CACHE_TTL_SETTING = "cache_ttl";

/** The 1-hour TTL against the 5-minute TTL, over one agent's requests. */
interface TtlComparison {
  /** What the 1-hour TTL costs more on writes, in micros. */
  extra: bigint;
  /** What the 1-hour TTL saves in rewrites on gaps of 5 to 60 minutes, in micros. */
  avoided: bigint;
  /** The gaps of 5 to 60 minutes weighed. */
  gaps: number;
  value: CacheTtl;
  /** The TTL every write used; absent when the requests used both. */
  current?: CacheTtl;
}

interface TtlTally {
  extra: bigint;
  avoided: bigint;
  gaps: number;
  wrote5m: number;
  wrote1h: number;
  /** False once a request the comparison needs has no price for a class. */
  priced: boolean;
}

/** What the prose reads about one finding. */
interface IdleStats {
  minGap: number;
  maxGap: number;
  /** Whether any cited rewrite had a 1-hour TTL. */
  oneHour: boolean;
  ttl: TtlComparison | null;
}

const statsOf = new WeakMap<Group, IdleStats>();

/** Whether a gap falls past 5 minutes and within the hour. */
function inHourBand(step: CacheStep): boolean {
  return (
    step.prev !== null &&
    step.gapMicros > TTL_MICROS["5m"] &&
    step.gapMicros <= TTL_MICROS["1h"]
  );
}

/**
 * Add one request to its agent's TTL comparison. The 1-hour TTL costs its
 * write price less the 5-minute write price on every token written, except
 * the rewrites it avoids. It avoids a rewrite on the 5-minute TTL after a gap
 * within the hour. On the 1-hour TTL, the same gap is a read the 5-minute TTL
 * would have written again.
 */
function tally(t: TtlTally, step: CacheStep): void {
  const tokens = step.frame.classTokens;
  if (tokens === undefined) return;
  const wrote = tokens.cache_write_5m + tokens.cache_write_1h;
  const band = inHourBand(step);
  if (wrote === 0 && !(band && step.readBack > 0)) return;
  const read = classPrice(step, "cache_read");
  const w5 = classPrice(step, "cache_write_5m");
  const w1h = classPrice(step, "cache_write_1h");
  if (read === null || w5 === null || w1h === null) {
    t.priced = false;
    return;
  }
  let avoidedTokens = 0;
  if (band && step.ttl === "5m" && isIdleRewrite(step)) {
    // Every class is priced here, so the premium is too.
    t.avoided += rewritePremium(step) ?? 0n;
    avoidedTokens = Math.min(step.rewritten, tokens.cache_write_5m);
    t.gaps += 1;
  } else if (
    band &&
    step.ttl === "1h" &&
    step.rewritten === 0 &&
    step.readBack > 0
  ) {
    t.avoided += perMillion(step.readBack, w5 - read);
    t.gaps += 1;
  }
  t.extra += perMillion(wrote - avoidedTokens, w1h - w5);
  t.wrote5m += tokens.cache_write_5m;
  t.wrote1h += tokens.cache_write_1h;
}

function comparisonOf(t: TtlTally): TtlComparison | null {
  if (!t.priced || t.wrote5m + t.wrote1h === 0) return null;
  const current: CacheTtl | undefined =
    t.wrote1h === 0 ? "5m" : t.wrote5m === 0 ? "1h" : undefined;
  return {
    extra: t.extra,
    avoided: t.avoided,
    gaps: t.gaps,
    value: t.avoided > t.extra ? "1h" : "5m",
    ...(current === undefined ? {} : { current }),
  };
}

function idleMeasure(step: CacheStep): Measure | null {
  const premium = rewritePremium(step);
  const keepAlive = keepAliveCost(step);
  const reads = keepAlivePings(step);
  const tokens = {
    measuredTokens: step.rewritten,
    counterfactualTokens: reads * step.rewritten,
  };
  if (premium === null || keepAlive === null)
    return reads > LIST_BREAKEVEN_READS[step.ttl]
      ? null
      : { ...tokens, micros: null };
  if (keepAlive >= premium) return null;
  return {
    ...tokens,
    micros: { measured: premium, counterfactual: keepAlive },
    basis: step.frame.basis,
  };
}

function detect(input: DetectInput, ctx: DetectContext): void {
  const cited = new Map<string, Omit<IdleStats, "ttl">>();
  const tallies = new Map<string, { key: FindingKey; tally: TtlTally }>();
  for (const step of cacheSteps(input)) {
    const key = agentOrOperator("idle_cache_rewrites", step.run);
    if (key === null || !ctx.groups.admits(key, step.run)) continue;
    const fingerprint = findingFingerprint(key.kind, key.level, key.subject);
    const entry = tallies.get(fingerprint) ?? {
      key,
      tally: {
        extra: 0n,
        avoided: 0n,
        gaps: 0,
        wrote5m: 0,
        wrote1h: 0,
        priced: true,
      },
    };
    tallies.set(fingerprint, entry);
    tally(entry.tally, step);
    if (!isIdleRewrite(step)) continue;
    const measure = idleMeasure(step);
    if (measure === null) continue;
    // The finding prices a part of the request, so it claims no frame and
    // cites the run as a whole.
    ctx.groups.add(key, input.window.start, step.run, measure, null);
    const seen = cited.get(fingerprint);
    cited.set(fingerprint, {
      minGap: Math.min(seen?.minGap ?? Infinity, step.gapMicros),
      maxGap: Math.max(seen?.maxGap ?? 0, step.gapMicros),
      oneHour: (seen?.oneHour ?? false) || step.ttl === "1h",
    });
  }
  const comparisons = new Map<string, TtlComparison | null>();
  for (const [fingerprint, { key, tally: t }] of tallies) {
    if (!cited.has(fingerprint)) continue;
    const comparison = comparisonOf(t);
    comparisons.set(fingerprint, comparison);
    if (comparison === null) continue;
    const recommendation: FindingRecommendation = {
      setting: CACHE_TTL_SETTING,
      value: comparison.value,
    };
    if (comparison.current !== undefined)
      recommendation.current = comparison.current;
    ctx.groups.recommend(key, recommendation);
  }
  for (const group of ctx.groups.values()) {
    if (group.kind !== "idle_cache_rewrites") continue;
    const fingerprint = findingFingerprint(
      group.kind,
      group.level,
      group.subject,
    );
    const seen = cited.get(fingerprint);
    if (seen === undefined) continue;
    statsOf.set(group, {
      ...seen,
      ttl: comparisons.get(fingerprint) ?? null,
    });
  }
}

const KEEP_ALIVE_WORDS: Readonly<Record<CacheTtl, string>> = {
  "5m": "send a keep-alive read every 4.5 minutes while it waits",
  "1h": "send a keep-alive read every 54 minutes while it waits",
};

function fixOf(subject: string, stats: IdleStats, currency: string): string {
  const t = stats.ttl;
  if (t === null)
    return stats.oneHour
      ? `For ${subject}, ${KEEP_ALIVE_WORDS["1h"]}.`
      : `For ${subject}, ${KEEP_ALIVE_WORDS["5m"]}, or raise its cache TTL to 1 hour.`;
  const keepAlive = KEEP_ALIVE_WORDS["5m"];
  const extra = formatMicros(t.extra, currency);
  const avoided = formatMicros(t.avoided, currency);
  const measured = t.current === "1h";
  const across =
    t.gaps === 0
      ? `No wait of 5 to 60 minutes came up, and the 1-hour TTL ${measured ? "cost" : "would have cost"} ${extra} more on writes.`
      : `Across ${plural(t.gaps, "wait", "waits")} of 5 to 60 minutes, the 1-hour TTL ${measured ? "cost" : "would have cost"} ${extra} more on writes and ${measured ? "avoided" : "would have avoided"} ${avoided} in rewrites.`;
  if (t.value === "1h")
    return t.current === "1h"
      ? `Keep the 1-hour cache TTL for ${subject}. ${across} For waits past an hour, ${KEEP_ALIVE_WORDS["1h"]}.`
      : `Set the cache TTL for ${subject} to 1 hour. ${across}`;
  return t.current === "5m"
    ? `Keep the 5-minute cache TTL for ${subject}, and ${keepAlive}. ${across}`
    : `Set the cache TTL for ${subject} to 5 minutes. ${across}`;
}

export const idleCacheRewrites: Detector = {
  kinds: ["idle_cache_rewrites"],
  counting: null,
  detect,
  prose: (group, evidence) => {
    const stats = statsOf.get(group) ?? {
      minGap: 0,
      maxGap: 0,
      oneHour: false,
      ttl: null,
    };
    const currency = currencyOf(group);
    const lo = gapMinutes(stats.minGap);
    const hi = gapMinutes(stats.maxGap);
    const waited = lo === hi ? `${lo} minutes` : `${lo} to ${hi} minutes`;
    const average =
      evidence.coveredCalls === 0
        ? 0
        : Math.round(evidence.measuredTokens / evidence.coveredCalls);
    const keepAlive = formatMicros(
      BigInt(evidence.counterfactualMicros),
      currency,
    );
    const rewrites = formatMicros(BigInt(evidence.measuredMicros), currency);
    return {
      why: `${group.subject} waited ${waited} ${plural(evidence.calls, "time", "times")}, and each wait rewrote a ${average.toLocaleString("en-US")}-token cache on average. A keep-alive would have cost ${keepAlive} against ${rewrites} in rewrites.`,
      fix: fixOf(group.subject, stats, currency),
    };
  },
};
