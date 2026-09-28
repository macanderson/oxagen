/**
 * Cache busts (detector 3, ADR-208): a request that wrote its cached prefix
 * again because the start of the prompt changed. The walk and the rewrite
 * rule are in ./cache-steps.ts. A rewrite is a bust when it came within the
 * TTL, so the prefix was still cached, or when the system context digest
 * changed, so no keep-alive would have held it. Every other rewrite waited
 * past the TTL and is an idle rewrite (./cache-expiry.ts).
 *
 * Each bust is priced at its premium: the rewritten tokens at the write price
 * less the read price, against nothing, since an unchanged prefix would have
 * been read back. A bust with no price is cited uncovered.
 *
 * The finding names, for each bust, the first part of the system context
 * whose digest changed (`changedPart`). A bust whose system context stayed
 * the same changed in the messages after it. It prices parts of requests, so
 * it claims no frame (ADR-208, counting rule 2).
 */
import {
  cacheSteps,
  changedPart,
  currencyOf,
  formatMicros,
  isBust,
  rewritePremium,
  type CacheStep,
} from "./cache-steps";
import {
  agentOrOperator,
  findingFingerprint,
  plural,
  type DetectContext,
  type Detector,
  type DetectInput,
  type Group,
  type Measure,
} from "./shared";

/** The parts a finding's prose names, most frequent first. */
const PARTS_NAMED = 3;

/** Where one finding's busts changed. */
interface BustStats {
  /** Each changed part's label and how many busts it began. */
  parts: Map<string, number>;
  /** The busts whose requests recorded no system context digest. */
  unknown: number;
}

const statsOf = new WeakMap<Group, BustStats>();

function emptyStats(): BustStats {
  return { parts: new Map<string, number>(), unknown: 0 };
}

function bustMeasure(step: CacheStep): Measure {
  const premium = rewritePremium(step);
  return {
    measuredTokens: step.rewritten,
    counterfactualTokens: 0,
    micros:
      premium === null ? null : { measured: premium, counterfactual: 0n },
    basis: step.frame.basis,
  };
}

function detect(input: DetectInput, ctx: DetectContext): void {
  const seen = new Map<string, BustStats>();
  for (const step of cacheSteps(input)) {
    if (!isBust(step) || step.prev === null) continue;
    const key = agentOrOperator("cache_busts", step.run);
    if (key === null || !ctx.groups.admits(key, step.run)) continue;
    // The finding prices a part of the request, so it claims no frame and
    // cites the run as a whole.
    ctx.groups.add(key, input.window.start, step.run, bustMeasure(step), null);
    const fingerprint = findingFingerprint(key.kind, key.level, key.subject);
    const stats = seen.get(fingerprint) ?? emptyStats();
    seen.set(fingerprint, stats);
    const part = changedPart(step.prev, step.frame);
    if (part === null) stats.unknown += 1;
    else stats.parts.set(part, (stats.parts.get(part) ?? 0) + 1);
  }
  for (const group of ctx.groups.values()) {
    if (group.kind !== "cache_busts") continue;
    const stats = seen.get(
      findingFingerprint(group.kind, group.level, group.subject),
    );
    if (stats !== undefined) statsOf.set(group, stats);
  }
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** The sentence that names where the busts began. */
function whereOf(stats: BustStats): string {
  const ranked = [...stats.parts].sort((a, b) =>
    b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  if (ranked.length === 0)
    return "No request recorded a system context digest, so the part that changed is unknown.";
  const named = ranked
    .slice(0, PARTS_NAMED)
    .map(([label, n]) => `${label} (${plural(n, "time", "times")})`);
  const rest = ranked.length - PARTS_NAMED;
  if (rest > 0) named.push(plural(rest, "other part", "other parts"));
  const unknown =
    stats.unknown === 0
      ? ""
      : ` ${plural(stats.unknown, "bust", "busts")} recorded no system context digest.`;
  return `The first change was in ${list(named)}.${unknown}`;
}

function topPart(stats: BustStats | undefined): string | null {
  if (stats === undefined) return null;
  let top: [string, number] | null = null;
  for (const entry of stats.parts)
    if (top === null || entry[1] > top[1]) top = entry;
  return top?.[0] ?? null;
}

export const cacheBusts: Detector = {
  kinds: ["cache_busts"],
  counting: null,
  detect,
  prose: (group, evidence) => {
    const stats = statsOf.get(group) ?? emptyStats();
    const premium = formatMicros(
      BigInt(evidence.measuredMicros),
      currencyOf(group),
    );
    const top = topPart(stats);
    const move =
      top === null
        ? "Move what changes below the cached prefix"
        : `Move what changes, such as ${top}, below the cached prefix`;
    return {
      why: `${group.subject} rewrote its cache ${plural(evidence.calls, "time", "times")} because the start of the prompt changed. ${whereOf(stats)} The rewrites cost ${premium} more than reading the cache back.`,
      fix: `Keep the start of the prompt for ${group.subject} the same from one request to the next. ${move}, or change it between runs.`,
    };
  },
};
