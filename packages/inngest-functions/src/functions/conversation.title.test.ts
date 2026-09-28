// `conversation.title`: the job that asks the fast model for a better name
// than the one cut from a conversation's first question (#4571). The model,
// the credit gate and the database are fakes, so the test holds the job's
// contract: every failure keeps the prompt title, and a rename that lands
// first wins.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  createFunction: vi.fn(),
  generate: vi.fn(),
  gate: vi.fn(),
  /** The conversation row the read finds, or none. */
  conversation: { id: "conv-1" } as { id: string } | null,
  /** The first user message the read finds, or none. */
  question: "https://github.com/macanderson/oxagen/pull/123 fix conflicts" as
    | string
    | null,
  /** Whether the guarded update still matches a prompt-titled row. */
  stillPromptTitled: true,
  writes: [] as Record<string, unknown>[],
}));

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../create-function", () => ({
  createFunction: state.createFunction,
}));
vi.mock("@oxagen/ai", () => ({
  CREDIT_REASONS: { CONSUME_ASSISTANT_TOKENS: "consume_assistant_tokens" },
  conversationTitlePrompt: () => "Name the conversation.",
  generateObjectFor: state.generate,
  loadWorkspacePromptConfigSafe: async () => null,
  resolveModelFundingSource: async () => ({ kind: "platform" }),
  resolvePrompt: ({ baseline }: { baseline: string }) => baseline,
  selectModelFromFunding: () => ({ model: "fast-model", fundedBy: "platform" }),
}));
vi.mock("@oxagen/billing", () => ({ evaluateTurnCreditGate: state.gate }));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@oxagen/database", async (original) => {
  const actual = await original<typeof import("@oxagen/database")>();
  return {
    ...actual,
    withTenantDb: async (fn: (tx: unknown) => unknown) =>
      fn({
        select: () => ({
          from: (table: unknown) => ({
            where: () =>
              table === actual.schema.conversations
                ? {
                    limit: async () =>
                      state.conversation ? [state.conversation] : [],
                  }
                : {
                    orderBy: () => ({
                      limit: async () =>
                        state.question === null
                          ? []
                          : [{ content: state.question }],
                    }),
                  },
          }),
        }),
        update: () => ({
          set: (value: Record<string, unknown>) => ({
            where: () => ({
              returning: async () => {
                if (!state.stillPromptTitled) return [];
                state.writes.push(value);
                return [{ id: "conv-1" }];
              },
            }),
          }),
        }),
      }),
  };
});

type Handler = (ctx: {
  event: { data: unknown };
  step: { run: (name: string, fn: () => Promise<unknown>) => Promise<unknown> };
}) => Promise<unknown>;
let handler: Handler | null = null;
let config: {
  concurrency?: { key: string; limit: number };
  id?: string;
} | null = null;
let trigger: { event?: string } | null = null;
state.createFunction.mockImplementation(
  (opts: typeof config, on: typeof trigger, fn: Handler) => {
    config = opts;
    trigger = on;
    handler = fn;
    return [{}];
  },
);

const { modelTitle } = await import("./conversation.title");

const steps: string[] = [];
const step = {
  run: (name: string, fn: () => Promise<unknown>) => {
    steps.push(name);
    return fn();
  },
};
const EVENT = { conversationId: "conv-1", orgId: "org-1", workspaceId: "ws-1" };
const run = (data: unknown) => {
  if (handler === null)
    throw new Error("conversation.title registered no handler");
  return handler({ event: { data }, step });
};

describe("conversation.title", () => {
  beforeEach(() => {
    state.generate.mockReset();
    state.gate.mockReset();
    state.gate.mockResolvedValue({ ok: true });
    state.conversation = { id: "conv-1" };
    state.question =
      "https://github.com/macanderson/oxagen/pull/123 fix conflicts";
    state.stillPromptTitled = true;
    state.writes = [];
    steps.length = 0;
  });

  it("names one conversation at a time, on the event a new conversation sends", () => {
    expect(config?.id).toBe("conversation.title");
    expect(config?.concurrency).toEqual({
      limit: 5,
      key: "event.data.conversationId",
    });
    expect(trigger?.event).toBe("chat/conversation.opened");
  });

  it("writes the model's subject over the prompt title", async () => {
    state.generate.mockResolvedValue({
      object: { title: '"Fix conflicts on PR 123."' },
    });
    await expect(run(EVENT)).resolves.toEqual({
      conversationId: "conv-1",
      outcome: "written",
    });
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toMatchObject({
      title: "Fix conflicts on PR 123",
      titleSource: "model",
    });
    expect(state.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: state.question,
        chargeReason: "consume_assistant_tokens",
        maxRetries: 0,
      }),
    );
    expect(steps).toEqual(["read-question", "name-conversation", "write-title"]);
  });

  it("sends the model at most 500 characters of the question", async () => {
    state.question = "x".repeat(2_000);
    state.generate.mockResolvedValue({ object: { title: "Long question" } });
    await run(EVENT);
    const [call] = state.generate.mock.calls[0] as [{ prompt: string }];
    expect(call.prompt).toHaveLength(500);
  });

  it("leaves a conversation alone once a person or the model renamed it (negative)", async () => {
    state.conversation = null;
    await expect(run(EVENT)).resolves.toEqual({
      conversationId: "conv-1",
      outcome: "not_prompt_titled",
    });
    expect(state.gate).not.toHaveBeenCalled();
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.writes).toHaveLength(0);
  });

  it("makes no call when the conversation has no question yet (negative)", async () => {
    state.question = "   ";
    await expect(run(EVENT)).resolves.toMatchObject({
      outcome: "not_prompt_titled",
    });
    expect(state.generate).not.toHaveBeenCalled();
  });

  it("keeps the prompt title when the credit gate refuses the call (negative)", async () => {
    state.gate.mockResolvedValue({ ok: false });
    await expect(run(EVENT)).resolves.toMatchObject({
      outcome: "credit_refused",
    });
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.writes).toHaveLength(0);
  });

  it("keeps the prompt title when the model call fails (negative)", async () => {
    state.generate.mockRejectedValue(new Error("gateway timeout"));
    await expect(run(EVENT)).resolves.toMatchObject({
      outcome: "model_failed",
    });
    expect(state.writes).toHaveLength(0);
    expect(steps).not.toContain("write-title");
  });

  it("keeps the prompt title when the model answers with nothing (negative)", async () => {
    state.generate.mockResolvedValue({ object: { title: ' "." ' } });
    await expect(run(EVENT)).resolves.toMatchObject({
      outcome: "empty_title",
    });
    expect(state.writes).toHaveLength(0);
  });

  it("lets a rename that lands during the call win (negative)", async () => {
    state.generate.mockResolvedValue({
      object: { title: "Fix conflicts on PR 123" },
    });
    state.stillPromptTitled = false;
    await expect(run(EVENT)).resolves.toEqual({
      conversationId: "conv-1",
      outcome: "renamed_meanwhile",
    });
    expect(state.writes).toHaveLength(0);
  });

  it("refuses an event that names no conversation or no scope, without a retry (negative)", async () => {
    for (const data of [
      {},
      null,
      { ...EVENT, conversationId: "" },
      { conversationId: "conv-1", orgId: "org-1" },
      { conversationId: "conv-1", workspaceId: "ws-1" },
    ])
      await expect(run(data)).rejects.toMatchObject({
        name: "NonRetriableError",
      });
    expect(state.generate).not.toHaveBeenCalled();
  });
});

describe("modelTitle", () => {
  it("drops the quotes and closing punctuation a model adds", () => {
    expect(modelTitle('"Fix conflicts on PR 123."')).toBe(
      "Fix conflicts on PR 123",
    );
    expect(modelTitle("“Why did the March invoice double?”")).toBe(
      "Why did the March invoice double",
    );
  });

  it("caps a long answer at 72 characters", () => {
    const title = modelTitle(
      "Investigate why the nightly ingestion job for the GitHub connector stalls after the first page of results",
    );
    expect(title).not.toBeNull();
    expect((title ?? "").length).toBeLessThanOrEqual(72);
  });

  it("returns null when nothing is left (negative)", () => {
    expect(modelTitle("")).toBeNull();
    expect(modelTitle(' "?!" ')).toBeNull();
  });
});
