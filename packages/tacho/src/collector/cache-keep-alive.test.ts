/**
 * The cache keep-alive's rules (lane F32): which request it repeats, when it
 * sends, how many one wait may send, and when it stops. The clock and the
 * vendor are fakes here, so every case runs in a few milliseconds. The same
 * rules end to end through the model proxy are in
 * `model-proxy-keep-alive.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  CACHE_TTL_MS,
  CacheKeepAlive,
  type CacheKeepAliveDeps,
  conversationOf,
  KEEP_ALIVE_INTERVAL_MS,
  KEEP_ALIVE_TICK_MS,
  type KeepAliveOutcome,
  keepAliveRequestOf,
  type KeepAliveSnapshot,
  mayKeepAlive,
  ttlOf,
} from "./cache-keep-alive";
import type { ModelPrice } from "./model-pricing";
import type { ObservedUsage } from "./model-usage";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-01T10:00:00.000Z");

/** List prices in micro-USD per million tokens: read 0.1, 5m write 1.25, 1h write 2. */
const LIST: ModelPrice = {
  provider: "anthropic",
  model: "claude-sonnet-5",
  input: 3_000_000,
  output: 15_000_000,
  cache_read: 300_000,
  cache_write: 3_750_000,
  cache_write_1h: 6_000_000,
};

const PARENT = "conversation-parent";
const SUBAGENT = "conversation-subagent";

/** A usage block for a request that left `prefix` tokens cached. */
function usage(
  prefix: number,
  options: { read?: number; ttl?: "5m" | "1h"; input?: number } = {},
): ObservedUsage {
  const read = options.read ?? 0;
  const write = prefix - read;
  return {
    inputTokens: options.input ?? 10,
    outputTokens: 50,
    cacheReadTokens: read,
    cacheCreationTokens: write,
    cacheCreation5mTokens: options.ttl === "1h" ? 0 : write,
    cacheCreation1hTokens: options.ttl === "1h" ? write : 0,
  };
}

interface Session {
  live: boolean;
  waiting: boolean;
}

/** A keep-alive with a settable clock, session and bundle, and a vendor that records each send. */
function harness(
  options: {
    finding?: string | undefined;
    price?: ModelPrice | undefined;
    outcome?: (snapshot: KeepAliveSnapshot<string>) => KeepAliveOutcome;
  } = {},
) {
  let now = T0;
  const session: Session = { live: true, waiting: false };
  const sent: Array<{ at: number; count: number; payload: string }> = [];
  const log: string[] = [];
  let finding: string | undefined =
    "finding" in options ? options.finding : "fnd_1";
  const deps: CacheKeepAliveDeps<Session, string> = {
    now: () => now,
    live: (s) => s.live,
    waiting: (s) => s.waiting,
    finding: () => finding,
    price: () => ("price" in options ? options.price : LIST),
    send: async (_s, snapshot, count) => {
      sent.push({ at: now, count, payload: snapshot.payload });
      return (
        options.outcome?.(snapshot) ?? {
          sent: true,
          startedAt: now,
          ok: true,
          readTokens: snapshot.prefixTokens,
        }
      );
    },
    log: (line) => log.push(line),
  };
  const keepAlive = new CacheKeepAlive(deps);
  return {
    keepAlive,
    session,
    sent,
    log,
    setFinding: (value: string | undefined) => {
      finding = value;
    },
    at: (ms: number) => {
      now = T0 + ms;
    },
    /** Tick every 15 seconds from now up to and including `untilMs`. */
    run: async (fromMs: number, untilMs: number) => {
      for (let t = fromMs; t <= untilMs; t += KEEP_ALIVE_TICK_MS) {
        now = T0 + t;
        await keepAlive.tick();
      }
    },
    call: (
      conversation: string,
      startedAtMs: number,
      used: ObservedUsage,
      payload = "parent-request",
    ) => {
      now = T0 + startedAtMs;
      keepAlive.observe("session-1", session, {
        conversation,
        model: "claude-sonnet-5",
        startedAt: T0 + startedAtMs,
        usage: used,
        payload,
      });
    },
  };
}

describe("the keep-alive request", () => {
  const parent = {
    model: "claude-sonnet-5",
    max_tokens: 32_000,
    stream: true,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system: [{ type: "text", text: "You are a coding agent." }],
    tools: [{ name: "Read", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: "Fix the build." }],
  };

  it("is the parent's request with max_tokens 0 and no stream, everything else as sent", () => {
    const keep = keepAliveRequestOf(parent);
    expect(keep).toEqual({
      model: "claude-sonnet-5",
      max_tokens: 0,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system: parent.system,
      tools: parent.tools,
      messages: parent.messages,
    });
    expect(keep).not.toHaveProperty("stream");
    // The parent's own request is untouched.
    expect(parent.stream).toBe(true);
    expect(parent.max_tokens).toBe(32_000);
  });

  it.each([
    ["a fixed thinking budget", { thinking: { type: "enabled", budget_tokens: 2048 } }],
    ["structured output", { output_config: { format: { type: "json_schema" } } }],
    ["forced tool use", { tool_choice: { type: "tool", name: "Read" } }],
    ["any tool", { tool_choice: { type: "any" } }],
    ["no conversation", { messages: [] }],
  ])("is not built for a request with %s (negative)", (_, change) => {
    expect(keepAliveRequestOf({ ...parent, ...change })).toBeUndefined();
  });

  it("keeps an automatic tool choice", () => {
    expect(
      keepAliveRequestOf({ ...parent, tool_choice: { type: "auto" } }),
    ).toMatchObject({ tool_choice: { type: "auto" }, max_tokens: 0 });
  });
});

describe("the conversation a request belongs to", () => {
  const first = {
    system: [{ type: "text", text: "You are a coding agent." }],
    tools: [{ name: "Read" }],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Fix the build.",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ],
  };

  it("stays the same while the harness moves its cache markers and adds turns", () => {
    const next = {
      ...first,
      messages: [
        { role: "user", content: [{ type: "text", text: "Fix the build." }] },
        { role: "assistant", content: "Reading the log." },
        {
          role: "user",
          content: [
            { type: "text", text: "Go on.", cache_control: { type: "ephemeral" } },
          ],
        },
      ],
    };
    expect(conversationOf(next, "claude-sonnet-5")).toBe(
      conversationOf(first, "claude-sonnet-5"),
    );
  });

  it("differs for a subagent's own prompt, a new system prompt, or another model (negative)", () => {
    const base = conversationOf(first, "claude-sonnet-5");
    expect(
      conversationOf(
        { ...first, messages: [{ role: "user", content: "Search the repo." }] },
        "claude-sonnet-5",
      ),
    ).not.toBe(base);
    expect(
      conversationOf({ ...first, system: "You are a searcher." }, "claude-sonnet-5"),
    ).not.toBe(base);
    expect(conversationOf(first, "claude-haiku-4-5")).not.toBe(base);
  });
});

describe("the TTL and the cost rule", () => {
  it("reads the TTL the request left its prefix on", () => {
    expect(ttlOf(usage(100_000), "1h")).toBe("5m");
    expect(ttlOf(usage(100_000, { ttl: "1h" }), "5m")).toBe("1h");
    expect(ttlOf(usage(100_000, { read: 100_000 }), "1h")).toBe("1h");
    expect(ttlOf({ cacheCreationTokens: 500 }, "1h")).toBe("5m");
  });

  it("sends at most 11 keep-alives a wait on the 5-minute TTL and 18 on the 1-hour TTL at list prices", () => {
    const most = (ttl: "5m" | "1h") => {
      let sent = 0;
      while (
        mayKeepAlive(
          sent,
          { prefixTokens: 100_000, uncachedTokens: 0, ttl },
          LIST,
        )
      )
        sent += 1;
      return sent;
    };
    expect(most("5m")).toBe(11);
    expect(most("1h")).toBe(18);
  });

  it("counts the uncached tail at the input price", () => {
    // 100,000 cached tokens read at 0.3 and 20,000 uncached at 3 cost 90,000
    // micro-units a time, against a 345,000 premium: three fit, not four.
    const snapshot = {
      prefixTokens: 100_000,
      uncachedTokens: 20_000,
      ttl: "5m" as const,
    };
    expect(mayKeepAlive(2, snapshot, LIST)).toBe(true);
    expect(mayKeepAlive(3, snapshot, LIST)).toBe(false);
  });

  it("never pays where a read costs as much as a write (negative)", () => {
    expect(
      mayKeepAlive(
        0,
        { prefixTokens: 100_000, uncachedTokens: 0, ttl: "5m" },
        { ...LIST, cache_write: LIST.cache_read },
      ),
    ).toBe(false);
  });
});

describe("a parent waiting on a subagent", () => {
  it("sends 2 keep-alives across a 12-minute wait on the 5-minute TTL, each before the prefix expires", async () => {
    const h = harness();
    h.call(PARENT, 0, usage(60_000));
    h.session.waiting = true;
    await h.run(0, 12 * MINUTE);
    expect(h.sent.map((s) => [s.at - T0, s.count])).toEqual([
      [KEEP_ALIVE_INTERVAL_MS["5m"], 1],
      [2 * KEEP_ALIVE_INTERVAL_MS["5m"], 2],
    ]);
    // Each one went out inside the TTL of the read before it, and the last
    // leaves the prefix cached past the parent's next request at 12 minutes.
    let anchor = 0;
    for (const s of h.sent) {
      expect(s.at - T0 - anchor).toBeLessThan(CACHE_TTL_MS["5m"]);
      anchor = s.at - T0;
    }
    expect(anchor + CACHE_TTL_MS["5m"]).toBeGreaterThan(12 * MINUTE);
  });

  it("sends the keep-alive 54 minutes after the read on the 1-hour TTL", async () => {
    const h = harness();
    h.call(PARENT, 0, usage(60_000, { ttl: "1h" }));
    h.session.waiting = true;
    await h.run(0, 60 * MINUTE);
    expect(h.sent.map((s) => s.at - T0)).toEqual([
      KEEP_ALIVE_INTERVAL_MS["1h"],
    ]);
  });

  it("sends nothing while no subagent is open (negative)", async () => {
    const h = harness();
    h.call(PARENT, 0, usage(60_000));
    await h.run(0, 4 * MINUTE + 59_000);
    expect(h.sent).toEqual([]);
    expect(h.keepAlive.size).toBe(1);
  });

  it("sends nothing when the bundle leaves the keep-alive off for the agent (negative)", async () => {
    const h = harness({ finding: undefined });
    h.call(PARENT, 0, usage(60_000));
    h.session.waiting = true;
    await h.run(0, 12 * MINUTE);
    expect(h.sent).toEqual([]);
    expect(h.keepAlive.size).toBe(0);
    expect(h.keepAlive.enabled()).toBe(false);
  });

  it("stops at the next tick once the bundle turns it off", async () => {
    const h = harness();
    h.call(PARENT, 0, usage(60_000));
    h.session.waiting = true;
    await h.run(0, 5 * MINUTE);
    expect(h.sent).toHaveLength(1);
    h.setFinding(undefined);
    await h.run(5 * MINUTE, 12 * MINUTE);
    expect(h.sent).toHaveLength(1);
  });

  it("stops a wait once its keep-alives would cost more than one rewrite", async () => {
    // Here a keep-alive costs 0.29 of one rewrite, so three fit and a fourth
    // would not.
    const h = harness({
      price: { ...LIST, cache_read: 1_000_000, cache_write: 4_500_000 },
    });
    h.call(PARENT, 0, usage(60_000));
    h.session.waiting = true;
    await h.run(0, 30 * MINUTE);
    expect(h.sent.map((s) => s.count)).toEqual([1, 2, 3]);
    expect(h.log.join("\n")).toMatch(/4 keep-alives would cost at least one rewrite of the prefix/);
  });

  it("sends nothing for a model with no price (negative)", async () => {
    const h = harness({ price: undefined });
    h.call(PARENT, 0, usage(60_000));
    h.session.waiting = true;
    await h.run(0, 12 * MINUTE);
    expect(h.sent).toEqual([]);
    expect(h.log.join("\n")).toMatch(/no price for claude-sonnet-5/);
  });

  it("keeps the parent's request while the subagent's calls land on the same session", async () => {
    const h = harness();
    h.call(PARENT, 0, usage(60_000), "parent-request");
    h.session.waiting = true;
    // The subagent's calls hold a larger prefix and still never replace the
    // parent's.
    h.call(SUBAGENT, 1 * MINUTE, usage(140_000), "subagent-request");
    h.call(SUBAGENT, 3 * MINUTE, usage(150_000, { read: 140_000 }), "subagent-request");
    await h.run(3 * MINUTE, 12 * MINUTE);
    expect(h.sent.map((s) => s.payload)).toEqual([
      "parent-request",
      "parent-request",
    ]);
  });

  it("follows the parent when it sends a request of its own during the wait, and counts from zero again", async () => {
    const h = harness({
      price: { ...LIST, cache_read: 1_000_000, cache_write: 4_500_000 },
    });
    h.call(PARENT, 0, usage(60_000), "first");
    h.session.waiting = true;
    await h.run(0, 10 * MINUTE);
    expect(h.sent.map((s) => s.count)).toEqual([1, 2]);
    // A background subagent: the parent works on while it runs.
    h.call(PARENT, 10 * MINUTE, usage(80_000, { read: 60_000 }), "second");
    await h.run(10 * MINUTE, 25 * MINUTE);
    expect(h.sent.slice(2).map((s) => [s.payload, s.count, s.at - T0])).toEqual([
      ["second", 1, 10 * MINUTE + KEEP_ALIVE_INTERVAL_MS["5m"]],
      ["second", 2, 10 * MINUTE + 2 * KEEP_ALIVE_INTERVAL_MS["5m"]],
      ["second", 3, 10 * MINUTE + 3 * KEEP_ALIVE_INTERVAL_MS["5m"]],
    ]);
  });

  it("lets no short side request displace the parent's larger prefix", async () => {
    const h = harness();
    h.call(PARENT, 0, usage(60_000), "parent-request");
    // A harness naming its session on a small model, before the subagent opens.
    h.call("conversation-title", 30_000, usage(2_000), "title-request");
    h.session.waiting = true;
    await h.run(30_000, 5 * MINUTE);
    expect(h.sent.map((s) => s.payload)).toEqual(["parent-request"]);
  });

  it("counts each wait from zero", async () => {
    const h = harness({
      price: { ...LIST, cache_read: 1_000_000, cache_write: 4_500_000 },
    });
    h.call(PARENT, 0, usage(60_000));
    h.session.waiting = true;
    await h.run(0, 14 * MINUTE);
    expect(h.sent).toHaveLength(3);
    // The subagent stops and another starts while the prefix is still held.
    h.session.waiting = false;
    await h.run(14 * MINUTE, 14 * MINUTE);
    h.session.waiting = true;
    await h.run(14 * MINUTE + KEEP_ALIVE_TICK_MS, 18 * MINUTE);
    expect(h.sent.map((s) => s.count)).toEqual([1, 2, 3, 1]);
  });

  it("stops the wait when a keep-alive reads nothing back, and drops the request once its prefix expires", async () => {
    const h = harness({
      outcome: () => ({ sent: true, startedAt: T0, ok: true, readTokens: 0 }),
    });
    h.call(PARENT, 0, usage(60_000));
    h.session.waiting = true;
    await h.run(0, 12 * MINUTE);
    expect(h.sent).toHaveLength(1);
    expect(h.log.join("\n")).toMatch(/read nothing back/);
    // Past the TTL nothing is left to hold, and neither is the request.
    expect(h.keepAlive.size).toBe(0);
  });

  it("stops the wait when the proxy sends nothing, such as for a paused session", async () => {
    const h = harness({
      outcome: () => ({ sent: false, reason: "session_paused" }),
    });
    h.call(PARENT, 0, usage(60_000));
    h.session.waiting = true;
    await h.run(0, 4 * MINUTE + 45_000);
    expect(h.sent).toHaveLength(1);
    expect(h.log.join("\n")).toMatch(/session_paused/);
  });

  it("forgets a session that sealed (negative)", async () => {
    const h = harness();
    h.call(PARENT, 0, usage(60_000));
    h.session.waiting = true;
    h.session.live = false;
    await h.run(0, 5 * MINUTE);
    expect(h.sent).toEqual([]);
    expect(h.keepAlive.size).toBe(0);
  });

  it("holds nothing for a request that cached nothing (negative)", () => {
    const h = harness();
    h.call(PARENT, 0, { inputTokens: 5_000, outputTokens: 10 });
    expect(h.keepAlive.size).toBe(0);
  });
});
