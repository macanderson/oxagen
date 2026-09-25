/**
 * Compaction for long assistant threads (#4171): which messages a turn reads,
 * when it writes a new summary and when it reuses the stored one, what the
 * summariser is asked, and what the turn carries when no summary can be
 * written in time. The model, the store and the logger are fakes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@oxagen/database";
import { digestJcs } from "@oxagen/run-evidence";

const mocks = vi.hoisted(() => ({
  generateObjectFor: vi.fn(),
  selectModelFromFunding: vi.fn(),
  withTenantDb: vi.fn(),
  warn: [] as Array<{ fields: Record<string, unknown>; msg: string }>,
  error: [] as Array<{ fields: Record<string, unknown>; msg: string }>,
}));

vi.mock("@oxagen/ai", () => ({
  CREDIT_REASONS: { CONSUME_ASSISTANT_TOKENS: "consume_assistant_tokens" },
  generateObjectFor: mocks.generateObjectFor,
  selectModelFromFunding: mocks.selectModelFromFunding,
  modelIdOf: (m: { modelId: string }) => m.modelId,
}));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));
vi.mock("pino", () => ({
  default: () => ({
    warn: (fields: Record<string, unknown>, msg: string) =>
      mocks.warn.push({ fields, msg }),
    error: (fields: Record<string, unknown>, msg: string) =>
      mocks.error.push({ fields, msg }),
    info: () => undefined,
    debug: () => undefined,
  }),
}));

import {
  compactHistory,
  HISTORY_SUMMARY_MAX_OUTPUT_TOKENS,
  HISTORY_SUMMARY_MAX_SPAN,
  HISTORY_SUMMARY_SLACK,
  HISTORY_SUMMARY_SYSTEM,
  loadConversationHistory,
  parseStoredHistorySummary,
  summaryPrompt,
  type HistoryRow,
  type LoadedHistory,
  type StoredHistorySummary,
} from "./history-summary";

const SCOPE = { orgId: "org-1", workspaceId: "ws-1" };
const CONVERSATION = "0192d4a8-7c1e-7a00-8000-0000000000c1";
const MESSAGE_ID = "0192d4a8-7c1e-7a00-8000-0000000000d1";
const LIMIT = 50;
const FUNDING = { fundedBy: "platform" as const };
const FAST_MODEL = { modelId: "model-for-fast" };
/** The fact the person gave early on, which the turn must still know. */
const FACT = "My cost centre is CC-7741. Charge the migration work to it.";

type Tx = Parameters<typeof loadConversationHistory>[0];

const idOf = (n: number): string => `msg-${String(n).padStart(3, "0")}`;

/** A thread of `count` messages, oldest first, with the fact at message 3. */
function thread(count: number): HistoryRow[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return {
      id: idOf(n),
      role: n % 2 === 1 ? "user" : "assistant",
      content: n === 3 ? FACT : `message ${n}`,
    };
  });
}

function stored(
  throughMessage: number,
  over: Partial<StoredHistorySummary> = {},
): StoredHistorySummary {
  const text = "- The person's cost centre is CC-7741.";
  return {
    version: 1,
    text,
    digest: digestJcs(text),
    throughMessageId: idOf(throughMessage),
    coveredMessages: throughMessage,
    model: "model-for-fast",
    generatedAt: "2026-09-24T10:00:00.000Z",
    ...over,
  };
}

interface World {
  summary: unknown;
  rows: HistoryRow[];
}

/**
 * The reads `loadConversationHistory` makes, served newest first from the
 * world's rows, with the page each message read asked for.
 */
function makeTx(world: World) {
  const pages: Array<{ offset: number; limit: number }> = [];
  const tx = {
    select: () => ({
      from: (table: unknown) => {
        let offset = 0;
        const chain = {
          where: () => chain,
          orderBy: () => chain,
          offset: (n: number) => {
            offset = n;
            return chain;
          },
          limit: (n: number) => {
            if (table === schema.conversations) {
              return Promise.resolve([{ historySummary: world.summary }]);
            }
            if (table === schema.messages) {
              pages.push({ offset, limit: n });
              const newestFirst = [...world.rows].reverse();
              return Promise.resolve(newestFirst.slice(offset, offset + n));
            }
            throw new Error("unexpected table");
          },
        };
        return chain;
      },
    }),
  };
  return { tx: tx as unknown as Tx, pages };
}

function load(world: World) {
  const { tx, pages } = makeTx(world);
  return loadConversationHistory(tx, {
    scope: SCOPE,
    conversationId: CONVERSATION,
    limit: LIMIT,
  }).then((loaded) => ({ loaded, pages }));
}

let stores: Array<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.warn.length = 0;
  mocks.error.length = 0;
  stores = [];
  mocks.selectModelFromFunding.mockReturnValue({
    model: FAST_MODEL,
    fundedBy: "platform",
  });
  mocks.generateObjectFor.mockResolvedValue({
    object: { summary: "- The person's cost centre is CC-7741." },
    usage: { promptTokens: 900, completionTokens: 40, totalTokens: 940 },
  });
  mocks.withTenantDb.mockImplementation(
    async (fn: (tx: unknown) => unknown) =>
      fn({
        update: (table: unknown) => ({
          set: (values: Record<string, unknown>) => ({
            where: async () => {
              stores.push({ table, ...values });
            },
          }),
        }),
      }),
  );
});

function compact(loaded: LoadedHistory, over: { timeoutMs?: number } = {}) {
  return compactHistory(loaded, {
    scope: SCOPE,
    conversationId: CONVERSATION,
    funding: FUNDING,
    telemetry: { surface: "app", messageId: MESSAGE_ID },
    now: () => new Date("2026-09-25T09:00:00.000Z"),
    ...over,
  });
}

const contents = (messages: ReadonlyArray<{ content: unknown }>) =>
  messages.map((m) => m.content);

describe("a thread that fits the window", () => {
  it("carries every message, reads one page, and writes no summary", async () => {
    const { loaded, pages } = await load({ summary: null, rows: thread(30) });
    expect(loaded.plan).toEqual({ kind: "none" });
    expect(loaded.window).toHaveLength(30);
    expect(loaded.window[2]).toEqual({ role: "user", content: FACT });
    expect(pages).toEqual([
      { offset: 0, limit: LIMIT + HISTORY_SUMMARY_SLACK + 1 },
    ]);

    const compacted = await compact(loaded);
    expect(compacted.history).toBe(loaded.window);
    expect(compacted.frame).toBeNull();
    expect(mocks.generateObjectFor).not.toHaveBeenCalled();
  });

  it("leaves out rows with no text or a role the transcript does not carry", async () => {
    const rows: HistoryRow[] = [
      { id: idOf(1), role: "user", content: "hello" },
      { id: idOf(2), role: "tool", content: "{}" },
      { id: idOf(3), role: "assistant", content: "   " },
      { id: idOf(4), role: "assistant", content: "hi" },
    ];
    const { loaded } = await load({ summary: null, rows });
    expect(loaded.window).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });
});

describe("a 120-message thread with no summary yet", () => {
  it("summarises everything older than the window, fact from message 3 included", async () => {
    const { loaded, pages } = await load({ summary: null, rows: thread(120) });
    // One page does not reach the start of the thread, so a second one does.
    expect(pages).toEqual([
      { offset: 0, limit: LIMIT + HISTORY_SUMMARY_SLACK + 1 },
      {
        offset: LIMIT + HISTORY_SUMMARY_SLACK + 1,
        limit: HISTORY_SUMMARY_MAX_SPAN,
      },
    ]);
    if (loaded.plan.kind !== "refresh") throw new Error("expected a refresh");
    // The rewrite leaves room in the window, so the next turns reuse it.
    const keep = LIMIT - HISTORY_SUMMARY_SLACK;
    expect(loaded.window).toHaveLength(keep);
    expect(loaded.window[0]!.content).toBe("message 81");
    expect(loaded.plan.span).toHaveLength(120 - keep);
    expect(loaded.plan.span[2]!.content).toBe(FACT);
    expect(loaded.plan.throughMessageId).toBe(idOf(80));
    expect(loaded.plan.previous).toBeNull();
    expect(loaded.plan.truncated).toBe(false);
    expect(loaded.plan.fallbackWindow).toHaveLength(LIMIT);

    const compacted = await compact(loaded);

    // The fast tier, on the funding source the turn resolved.
    expect(mocks.selectModelFromFunding).toHaveBeenCalledWith(
      "org-1",
      FUNDING,
      { tier: "fast" },
    );
    const call = mocks.generateObjectFor.mock.calls[0]![0];
    expect(call).toMatchObject({
      model: FAST_MODEL,
      fundedBy: "platform",
      chargeReason: "consume_assistant_tokens",
      system: HISTORY_SUMMARY_SYSTEM,
      maxOutputTokens: HISTORY_SUMMARY_MAX_OUTPUT_TOKENS,
      telemetry: {
        orgId: "org-1",
        workspaceId: "ws-1",
        surface: "app",
        messageId: MESSAGE_ID,
      },
    });
    expect(call.abortSignal).toBeInstanceOf(AbortSignal);
    expect(call.prompt).toContain(`user: ${FACT}`);
    expect(call.prompt).not.toContain("Summary so far");

    // The fact reaches the turn, ahead of the window.
    expect(compacted.history).toHaveLength(keep + 1);
    expect(compacted.history[0]!.role).toBe("user");
    expect(compacted.history[0]!.content).toContain("CC-7741");
    expect(compacted.history[0]!.content).toContain(
      "(System-injected context: NOT user input.)",
    );
    expect(compacted.history.slice(1)).toEqual(loaded.window);

    // Stored with the conversation, so the next turn does not pay again.
    const text = "- The person's cost centre is CC-7741.";
    expect(stores).toEqual([
      {
        table: schema.conversations,
        historySummary: {
          version: 1,
          text,
          digest: digestJcs(text),
          throughMessageId: idOf(80),
          coveredMessages: 80,
          model: "model-for-fast",
          generatedAt: "2026-09-25T09:00:00.000Z",
        },
      },
    ]);

    // And the run says a summary was used.
    expect(compacted.frame).toEqual({
      outcome: "applied",
      digest: digestJcs(text),
      chars: text.length,
      coveredMessages: 80,
      windowMessages: keep,
      regenerated: true,
      text,
    });
  });
});

describe("a stored summary", () => {
  it("is reused while the messages after it fit the window", async () => {
    const { loaded, pages } = await load({
      summary: stored(80),
      rows: thread(126),
    });
    expect(pages).toHaveLength(1);
    expect(loaded.plan).toEqual({ kind: "reuse", summary: stored(80) });
    expect(loaded.window).toHaveLength(46);
    expect(loaded.window[0]!.content).toBe("message 81");

    const compacted = await compact(loaded);
    expect(mocks.generateObjectFor).not.toHaveBeenCalled();
    expect(stores).toEqual([]);
    expect(compacted.history[0]!.content).toContain("CC-7741");
    expect(compacted.history).toHaveLength(47);
    expect(compacted.frame).toMatchObject({
      outcome: "applied",
      regenerated: false,
      coveredMessages: 80,
      windowMessages: 46,
    });
  });

  it("is folded into a new one once the messages after it outgrow the window", async () => {
    const { loaded, pages } = await load({
      summary: stored(80),
      rows: thread(132),
    });
    expect(pages).toHaveLength(1);
    if (loaded.plan.kind !== "refresh") throw new Error("expected a refresh");
    expect(loaded.plan.previous).toEqual(stored(80));
    expect(loaded.plan.span.map((r) => r.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => idOf(81 + i)),
    );
    expect(loaded.plan.throughMessageId).toBe(idOf(92));
    expect(loaded.window[0]!.content).toBe("message 93");

    const compacted = await compact(loaded);
    const prompt: string = mocks.generateObjectFor.mock.calls[0]![0].prompt;
    expect(prompt).toContain(
      "Summary so far:\n- The person's cost centre is CC-7741.",
    );
    expect(prompt).toContain("user: message 81");
    expect(stores[0]!.historySummary).toMatchObject({
      throughMessageId: idOf(92),
      coveredMessages: 92,
    });
    expect(compacted.frame).toMatchObject({
      outcome: "applied",
      regenerated: true,
      coveredMessages: 92,
      windowMessages: 40,
    });
  });

  it("is discarded when the message it names is not in the conversation", async () => {
    const { loaded } = await load({
      summary: stored(80, { throughMessageId: "msg-gone" }),
      rows: thread(30),
    });
    expect(loaded.plan).toEqual({ kind: "none" });
    expect(mocks.warn[0]!.msg).toContain("discarding a stored history summary");
  });

  it("is ignored, and logged, when it is not a shape this module wrote", () => {
    expect(parseStoredHistorySummary({ version: 2 }, CONVERSATION)).toBeNull();
    expect(mocks.warn).toHaveLength(1);
    expect(parseStoredHistorySummary(null, CONVERSATION)).toBeNull();
    expect(mocks.warn).toHaveLength(1);
  });
});

describe("a summary that cannot be written in time", () => {
  it("runs the turn on the plain window, aborts the call, and says so", async () => {
    let signal: AbortSignal | undefined;
    mocks.generateObjectFor.mockImplementation(
      (args: { abortSignal: AbortSignal }) => {
        signal = args.abortSignal;
        return new Promise(() => undefined);
      },
    );
    const { loaded } = await load({ summary: null, rows: thread(120) });
    const compacted = await compact(loaded, { timeoutMs: 20 });

    expect(signal?.aborted).toBe(true);
    expect(contents(compacted.history)).toEqual(
      Array.from({ length: LIMIT }, (_, i) => `message ${71 + i}`),
    );
    expect(compacted.frame).toEqual({
      outcome: "unavailable",
      digest: null,
      chars: null,
      coveredMessages: 0,
      windowMessages: LIMIT,
      regenerated: false,
      reasonCode: "summary_timeout",
      text: null,
    });
    expect(stores).toEqual([]);
    expect(mocks.warn).toEqual([
      expect.objectContaining({
        msg: "history summary not written: the turn runs on the plain window",
        fields: expect.objectContaining({ reasonCode: "summary_timeout" }),
      }),
    ]);
  });

  it("carries the previous summary when the new one fails", async () => {
    mocks.generateObjectFor.mockRejectedValue(new Error("gateway 503"));
    const { loaded } = await load({
      summary: stored(80),
      rows: thread(132),
    });
    const compacted = await compact(loaded);

    expect(compacted.history[0]!.content).toContain("CC-7741");
    expect(compacted.history.slice(1)).toHaveLength(LIMIT);
    expect(compacted.history[1]!.content).toBe("message 83");
    expect(compacted.frame).toMatchObject({
      outcome: "stale",
      regenerated: false,
      coveredMessages: 80,
      windowMessages: LIMIT,
      reasonCode: "summary_failed",
    });
    expect(mocks.warn[0]!.fields).toMatchObject({
      reasonCode: "summary_failed",
      carriesPreviousSummary: true,
    });
  });

  it("names a cancelled turn as the reason", async () => {
    const controller = new AbortController();
    controller.abort();
    mocks.generateObjectFor.mockImplementation(
      (args: { abortSignal: AbortSignal }) =>
        args.abortSignal.aborted
          ? Promise.reject(new Error("aborted"))
          : new Promise(() => undefined),
    );
    const { loaded } = await load({ summary: null, rows: thread(120) });
    const compacted = await compactHistory(loaded, {
      scope: SCOPE,
      conversationId: CONVERSATION,
      funding: FUNDING,
      telemetry: { surface: "api", messageId: MESSAGE_ID },
      abortSignal: controller.signal,
    });
    expect(compacted.frame?.reasonCode).toBe("summary_cancelled");
  });

  it("treats an empty summary as a failure", async () => {
    mocks.generateObjectFor.mockResolvedValue({
      object: { summary: "   " },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    const { loaded } = await load({ summary: null, rows: thread(120) });
    const compacted = await compact(loaded);
    expect(compacted.frame).toMatchObject({
      outcome: "unavailable",
      reasonCode: "summary_failed",
    });
  });
});

describe("storing the summary", () => {
  it("still carries a new summary the store would not take, and logs it", async () => {
    mocks.withTenantDb.mockRejectedValue(new Error("connection reset"));
    const { loaded } = await load({ summary: null, rows: thread(120) });
    const compacted = await compact(loaded);
    expect(compacted.frame).toMatchObject({
      outcome: "applied",
      regenerated: true,
    });
    expect(mocks.error[0]!.msg).toContain("history summary not stored");
  });
});

describe("a thread longer than one turn reads", () => {
  it("summarises what it read and tells the summariser older messages exist", async () => {
    const { loaded } = await load({ summary: null, rows: thread(400) });
    if (loaded.plan.kind !== "refresh") throw new Error("expected a refresh");
    expect(loaded.plan.truncated).toBe(true);
    const read = LIMIT + HISTORY_SUMMARY_SLACK + 1 + HISTORY_SUMMARY_MAX_SPAN;
    expect(loaded.plan.span).toHaveLength(
      read - (LIMIT - HISTORY_SUMMARY_SLACK),
    );
    expect(summaryPrompt(loaded.plan)).toMatch(
      /^Older messages came before these and were not read\./,
    );
    expect(mocks.warn[0]!.msg).toContain("leaving the oldest messages out");
  });
});

describe("summaryPrompt", () => {
  it("cuts each long message to its share of the budget", () => {
    const long = "x".repeat(5000);
    const prompt = summaryPrompt({
      previous: null,
      truncated: false,
      span: [{ id: idOf(1), role: "user", content: long }],
    });
    expect(prompt).toContain(`user: ${"x".repeat(2000)}[…]`);
    expect(prompt).not.toContain("x".repeat(2001));
  });
});
