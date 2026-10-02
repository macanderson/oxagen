/**
 * The cache keep-alive (spend spec, detector 3's second lever; lane F32).
 *
 * A vendor's prompt cache holds a request's prefix for a time to live (TTL)
 * that restarts each time a request reads it: 5 minutes by default, or 1 hour.
 * A parent run that waits on a subagent sends nothing while it waits, so a
 * wait past the TTL lets the prefix expire, and the parent's next request
 * writes it again at the write price. The sample priced those rewrites at
 * 3.7% of spend, against 0.3% for a keep-alive read every 4.5 minutes.
 *
 * So while a parent waits, the model proxy sends the parent's last request
 * again with `max_tokens: 0` and streaming off, shortly before the prefix
 * would expire. The vendor reads the prefix, which restarts its TTL, and
 * answers with no output. It bills one cache read and the few uncached tokens
 * after the last cache breakpoint.
 *
 * This module decides when. The proxy does the sending, because the request
 * it repeats carries the caller's credential, and that never leaves the proxy.
 *
 * - **Which request.** The proxy hands over each Anthropic Messages call that
 *   lands with a cached prefix (`observe`). A subagent's calls reach the proxy
 *   on its parent's session, so a call counts as the parent's only when no
 *   subagent is open, or when it continues the conversation the parent's last
 *   call held (`conversationOf`): same model, system, tools, and first
 *   message. A subagent opens its own conversation, so its calls never
 *   replace the parent's.
 * - **When.** A session waits while a subagent is open (`waiting`). Each
 *   keep-alive goes out 90% of the TTL after the start of the last request
 *   that read the prefix: 4.5 minutes on the 5-minute TTL and 54 on the
 *   1-hour TTL, as `cache-steps.ts` in `@oxagen/billing` prices it. The TTL is
 *   counted from a request's start, so the anchor is the start, not the end.
 * - **Whether.** Only when the bundle turns the keep-alive on for this
 *   agent (`finding`). The control plane signs that answer from the agent's
 *   idle cache finding, which shows the keep-alive costs less than the
 *   rewrites it saves (decision 6), and the owning team can turn it off.
 * - **How many.** One wait stops sending once its keep-alives would cost more
 *   than one rewrite of the prefix (`mayKeepAlive`). A model with no price
 *   sends nothing: a keep-alive spends the operator's money, so the proxy
 *   sends one only when it can show the trade pays.
 * - **When it stops.** The wait ends when no subagent is open, the session
 *   seals, the bundle turns the keep-alive off, the prefix has already
 *   expired, or a keep-alive fails or reads nothing back. A new wait starts
 *   its count again, and so does a request the parent sends itself.
 *
 * The request shapes `max_tokens: 0` refuses are left alone: a fixed thinking
 * budget (`thinking.type: "enabled"`), structured output
 * (`output_config.format`), and forced tool use. Changing any of them would
 * change the cached prefix, so the keep-alive would write a new cache rather
 * than hold the old one.
 *
 * The module holds no timer and reads no clock of its own: the proxy calls
 * `tick` on an interval, and tests call it with the clock they choose.
 * `@oxagen/billing` cannot be imported by this leaf package, so the TTLs and
 * intervals are written out here; `cache-steps.ts` holds the same numbers.
 */
import { createHash } from "node:crypto";
import type { ModelPrice } from "./model-pricing";
import type { ObservedUsage } from "./model-usage";

/** A prompt cache's time to live, as the vendor's usage reports its writes. */
export type CacheTtl = "5m" | "1h";

const MINUTE_MS = 60_000;

/** Each TTL in milliseconds. */
export const CACHE_TTL_MS: Readonly<Record<CacheTtl, number>> = {
  "5m": 5 * MINUTE_MS,
  "1h": 60 * MINUTE_MS,
};

/**
 * How long after the start of the last request that read the prefix a
 * keep-alive goes out: 90% of the TTL, as `KEEP_ALIVE_MICROS` in
 * `packages/billing/src/findings/cache-steps.ts` prices it.
 */
export const KEEP_ALIVE_INTERVAL_MS: Readonly<Record<CacheTtl, number>> = {
  "5m": 4.5 * MINUTE_MS,
  "1h": 54 * MINUTE_MS,
};

/**
 * How often the proxy checks for a keep-alive that is due. A keep-alive goes
 * out at most this late, and 4.5 minutes plus 15 seconds is still inside the
 * 5-minute TTL.
 */
export const KEEP_ALIVE_TICK_MS = 15_000;

/** The most sessions whose parent request the proxy holds for a keep-alive. */
const MAX_SESSIONS = 32;

/** Marks an `llm_call` frame the proxy sent as a keep-alive. */
export const KEEP_ALIVE_ATTR = "oxagen.cache_keep_alive";
/** The public id of the idle cache finding that turned the keep-alive on. */
export const KEEP_ALIVE_FINDING_ATTR = "oxagen.cache_keep_alive_finding";
/** Which keep-alive of its wait this one is, counting from 1. */
export const KEEP_ALIVE_COUNT_ATTR = "oxagen.cache_keep_alive_count";
/** The TTL of the prefix the keep-alive held. */
export const KEEP_ALIVE_TTL_ATTR = "oxagen.cache_ttl";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The request a keep-alive sends for a parent request: the same request with
 * `max_tokens: 0` and no `stream` member. Undefined when the request names a
 * setting `max_tokens: 0` refuses, or carries no conversation.
 *
 * Everything else is kept as the parent sent it, the thinking and effort
 * settings included: the vendor renders those into the prefix, so a
 * keep-alive that changed one would read nothing back.
 */
export function keepAliveRequestOf(
  request: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const messages = request["messages"];
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  const thinking = request["thinking"];
  if (isObject(thinking) && thinking["type"] === "enabled") return undefined;
  const output = request["output_config"];
  if (isObject(output) && output["format"] !== undefined) return undefined;
  const choice = request["tool_choice"];
  if (
    isObject(choice) &&
    (choice["type"] === "any" || choice["type"] === "tool")
  )
    return undefined;
  const copy: Record<string, unknown> = { ...request, max_tokens: 0 };
  delete copy["stream"];
  return copy;
}

/** A copy of a JSON value with every `cache_control` member left out. */
function withoutCacheMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheMarkers);
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    if (key === "cache_control") continue;
    out[key] = withoutCacheMarkers(member);
  }
  return out;
}

/**
 * The conversation a request belongs to: a digest of its model, system
 * prompt, tool definitions, and first message. A parent's requests keep all
 * four from call to call, and a subagent starts with its own system prompt
 * and first message. Cache markers are left out, because a harness moves
 * them to the newest message on every call.
 */
export function conversationOf(
  request: Record<string, unknown>,
  model: string,
): string {
  const messages = request["messages"];
  const first: unknown = Array.isArray(messages)
    ? (messages as unknown[])[0]
    : undefined;
  const text = JSON.stringify([
    model,
    withoutCacheMarkers(request["system"] ?? null),
    withoutCacheMarkers(request["tools"] ?? null),
    withoutCacheMarkers(first ?? null),
  ]);
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/**
 * The TTL a request left its prefix on. Any 5-minute write leaves a 5-minute
 * tail, so the prefix expires at 5 minutes. A request that wrote nothing
 * keeps the TTL the prefix already had. This is the rule `cache-steps.ts`
 * walks frames by.
 */
export function ttlOf(usage: ObservedUsage, previous: CacheTtl): CacheTtl {
  const oneHour = usage.cacheCreation1hTokens ?? 0;
  const fiveMinute =
    usage.cacheCreation5mTokens ??
    Math.max(0, (usage.cacheCreationTokens ?? 0) - oneHour);
  if (fiveMinute > 0) return "5m";
  if (oneHour > 0) return "1h";
  return previous;
}

/** The tokens a request left cached: what it read and what it wrote. */
export function prefixTokensOf(usage: ObservedUsage): number {
  return (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
}

/**
 * Whether one more keep-alive in this wait still costs less than one rewrite
 * of the prefix. A keep-alive costs the prefix at the read price and the
 * uncached tail at the input price. A rewrite costs the prefix at the write
 * price less the read price, the premium detector 3 prices. `sent` is how many
 * this wait already sent.
 *
 * At list prices on the 5-minute TTL a read is 0.1 of the input price and a
 * write 1.25, so a wait sends at most 11 keep-alives. On the 1-hour TTL the
 * write is 2, so at most 18. Those are `LIST_BREAKEVEN_READS` in
 * `cache-expiry.ts`.
 */
export function mayKeepAlive(
  sent: number,
  snapshot: Pick<KeepAliveSnapshot, "prefixTokens" | "uncachedTokens" | "ttl">,
  price: ModelPrice,
): boolean {
  const write =
    snapshot.ttl === "1h"
      ? (price.cache_write_1h ?? price.cache_write)
      : price.cache_write;
  const premium = snapshot.prefixTokens * (write - price.cache_read);
  const keepAlive =
    snapshot.prefixTokens * price.cache_read +
    snapshot.uncachedTokens * price.input;
  // Strictly less: keep-alives that only break even with the rewrite buy
  // nothing, and `LIST_BREAKEVEN_READS` counts the same way.
  return premium > 0 && (sent + 1) * keepAlive < premium;
}

/** What the module knows of a parent's last request. */
export interface KeepAliveSnapshot<P = unknown> {
  /** `conversationOf` the request. */
  conversation: string;
  model: string;
  ttl: CacheTtl;
  /** The tokens the request left cached. */
  prefixTokens: number;
  /** The request's uncached input: the tail after its last cache breakpoint. */
  uncachedTokens: number;
  /** When the last request that read or wrote the prefix started, epoch ms. */
  anchorAt: number;
  /**
   * What the proxy needs to send the keep-alive. The module never reads,
   * logs, or records it: it holds the caller's credential.
   */
  payload: P;
}

/** One landed call the proxy hands to `observe`. */
export interface ObservedCall<P> {
  conversation: string;
  model: string;
  /** When the call started, epoch ms. */
  startedAt: number;
  usage: ObservedUsage;
  payload: P;
}

/** What one keep-alive came to. */
export type KeepAliveOutcome =
  /** The proxy sent nothing, and says why. */
  | { sent: false; reason: string }
  | {
      sent: true;
      /** When the keep-alive started, epoch ms: the prefix's new anchor. */
      startedAt: number;
      /** The vendor answered with a success. */
      ok: boolean;
      /** The cached tokens the vendor reported reading back. */
      readTokens: number;
    };

export interface CacheKeepAliveDeps<S, P> {
  now: () => number;
  /** Whether the session still takes frames. */
  live: (session: S) => boolean;
  /** Whether the parent waits: a subagent of the session is open. */
  waiting: (session: S) => boolean;
  /**
   * The finding the bundle turns the keep-alive on with, or undefined when
   * the bundle leaves it off for this agent.
   */
  finding: () => string | undefined;
  /** The price row for a model, or undefined when the bundle has none. */
  price: (model: string) => ModelPrice | undefined;
  /** Send one keep-alive and record its frame. */
  send: (
    session: S,
    snapshot: KeepAliveSnapshot<P>,
    count: number,
    finding: string,
  ) => Promise<KeepAliveOutcome>;
  log: (line: string) => void;
}

interface SessionState<S, P> {
  session: S;
  snapshot: KeepAliveSnapshot<P>;
  /** Keep-alives this wait sent. */
  sent: number;
  /** This wait sends no more. */
  stopped: boolean;
  inFlight: boolean;
}

export class CacheKeepAlive<S, P> {
  private readonly sessions = new Map<string, SessionState<S, P>>();

  constructor(private readonly deps: CacheKeepAliveDeps<S, P>) {}

  /**
   * Whether the bundle turns the keep-alive on, so the proxy builds a
   * keep-alive request for each call. When it is off the proxy builds none
   * and holds nothing.
   */
  enabled(): boolean {
    return this.deps.finding() !== undefined;
  }

  /** How many sessions hold a parent request. */
  get size(): number {
    return this.sessions.size;
  }

  /** The conversation of the parent request a session holds, if it holds one. */
  conversationFor(key: string): string | undefined {
    return this.sessions.get(key)?.snapshot.conversation;
  }

  /**
   * A call landed with a usage the vendor reported. It becomes the session's
   * parent request when it continues the parent's conversation, or when no
   * subagent is open and it holds the larger prefix. A request the parent
   * sends itself also starts the wait's count again: the parent is not
   * waiting while it sends one.
   */
  observe(key: string, session: S, call: ObservedCall<P>): void {
    if (!this.enabled()) {
      this.sessions.delete(key);
      return;
    }
    const held = this.sessions.get(key);
    const same = held?.snapshot.conversation === call.conversation;
    const prefixTokens = prefixTokensOf(call.usage);
    if (!same) {
      // While a subagent is open, a call in another conversation is the
      // subagent's.
      if (this.deps.waiting(session)) return;
      if (prefixTokens === 0) return;
      // A short side request, such as a harness naming its session on a
      // smaller model, does not displace a larger prefix still cached.
      if (
        held !== undefined &&
        prefixTokens < held.snapshot.prefixTokens &&
        this.deps.now() <
          held.snapshot.anchorAt + CACHE_TTL_MS[held.snapshot.ttl]
      )
        return;
    } else if (prefixTokens === 0) {
      // The parent's own request cached nothing, so no prefix is left to hold.
      this.sessions.delete(key);
      return;
    }
    const snapshot: KeepAliveSnapshot<P> = {
      conversation: call.conversation,
      model: call.model,
      ttl: ttlOf(call.usage, same && held ? held.snapshot.ttl : "5m"),
      prefixTokens,
      uncachedTokens: call.usage.inputTokens ?? 0,
      anchorAt: call.startedAt,
      payload: call.payload,
    };
    // The state object is kept, not replaced, so a keep-alive still out
    // settles on the state that holds the new request.
    const state: SessionState<S, P> = held ?? {
      session,
      snapshot,
      sent: 0,
      stopped: false,
      inFlight: false,
    };
    state.session = session;
    state.snapshot = snapshot;
    state.sent = 0;
    state.stopped = false;
    // Re-inserted, so the map's order is last-use order, then trimmed.
    this.sessions.delete(key);
    this.sessions.set(key, state);
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }

  /** Drop what a session holds. */
  forget(key: string): void {
    this.sessions.delete(key);
  }

  /** Drop everything. */
  clear(): void {
    this.sessions.clear();
  }

  /**
   * Send every keep-alive that is due. The proxy calls this on an interval;
   * it resolves once every keep-alive it started has settled.
   */
  async tick(): Promise<void> {
    const sends: Promise<void>[] = [];
    for (const [key, state] of [...this.sessions]) {
      const send = this.due(key, state);
      if (send !== undefined) sends.push(send);
    }
    await Promise.all(sends);
  }

  private due(
    key: string,
    state: SessionState<S, P>,
  ): Promise<void> | undefined {
    if (!this.deps.live(state.session)) {
      this.sessions.delete(key);
      return undefined;
    }
    if (state.inFlight) return undefined;
    const snapshot = state.snapshot;
    const now = this.deps.now();
    const waiting = this.deps.waiting(state.session);
    if (now >= snapshot.anchorAt + CACHE_TTL_MS[snapshot.ttl]) {
      // The prefix expired, so nothing is left to hold, and a keep-alive now
      // would write it again: the cost it exists to avoid. The request and
      // its credential are dropped with it.
      this.sessions.delete(key);
      if (waiting && !state.stopped)
        this.deps.log(
          "model proxy: cache keep-alive stopped for this wait: the cached prefix already expired",
        );
      return undefined;
    }
    if (!waiting) {
      // The wait ended, or never began. The next one counts from zero.
      state.sent = 0;
      state.stopped = false;
      return undefined;
    }
    if (state.stopped) return undefined;
    const finding = this.deps.finding();
    if (finding === undefined) return undefined;
    if (now < snapshot.anchorAt + KEEP_ALIVE_INTERVAL_MS[snapshot.ttl])
      return undefined;
    const price = this.deps.price(snapshot.model);
    if (price === undefined) {
      this.stop(state, `no price for ${snapshot.model}`);
      return undefined;
    }
    const count = state.sent + 1;
    if (!mayKeepAlive(state.sent, snapshot, price)) {
      this.stop(
        state,
        `${count} keep-alive${count === 1 ? "" : "s"} would cost at least one rewrite of the prefix`,
      );
      return undefined;
    }
    state.inFlight = true;
    // Through a promise, so a send that throws stops this wait and no other.
    return Promise.resolve()
      .then(() => this.deps.send(state.session, snapshot, count, finding))
      .catch(
        (error: unknown): KeepAliveOutcome => ({
          sent: false,
          reason: error instanceof Error ? error.message : String(error),
        }),
      )
      .then((outcome) => {
        state.inFlight = false;
        // The parent sent a request of its own while this one was out: that
        // request holds the prefix now, and its count starts again.
        if (state.snapshot !== snapshot) return;
        if (!outcome.sent) {
          this.stop(state, outcome.reason);
          return;
        }
        if (!outcome.ok || outcome.readTokens === 0) {
          this.stop(
            state,
            outcome.ok
              ? "the keep-alive read nothing back from the cache"
              : "the vendor refused the keep-alive",
          );
          return;
        }
        snapshot.anchorAt = outcome.startedAt;
        state.sent = count;
      });
  }

  private stop(state: SessionState<S, P>, reason: string): void {
    state.stopped = true;
    this.deps.log(`model proxy: cache keep-alive stopped for this wait: ${reason}`);
  }
}
