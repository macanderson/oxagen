import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";

// Mock the metered AI port so no real model is called. `generateObjectFor` is
// the only LLM entry point; `selectModel` just returns an opaque handle.
const generateObjectFor = vi.fn();
vi.mock("@oxagen/ai", () => ({
  // Funding is resolved before the model call (ADR-053 §3); an org with no
  // stored key is platform-funded, which is what these fixtures exercise.
  resolveModelFundingSource: async () => ({ fundedBy: "platform" }),
  generateObjectFor: (...args: unknown[]) => generateObjectFor(...args),
  selectModel: () => "fast-model" as unknown,
}));

// Silence the best-effort warn logger.
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  buildRecentTurns,
  extractToolActivity,
  extractTurnText,
  generateTurnSuggestions,
  renderTurnActivity,
} from "./suggest-prompts";

const baseInput = {
  orgId: "org-1",
  workspaceId: "ws-1",
  messageId: "11111111-1111-1111-1111-111111111111",
  orgSlug: "acme",
  workspaceSlug: "prod",
};

const threeSuggestions = [
  { label: "Turn Into An Agent", prompt: "Create an agent that does this." },
  { label: "Automate This", prompt: "Automate this on a schedule." },
  { label: "Add To Graph", prompt: "Wire this into the knowledge graph." },
];

describe("extractTurnText", () => {
  it("returns a plain string content unchanged", () => {
    expect(extractTurnText("hello world")).toBe("hello world");
  });

  it("joins the text parts of an array content and drops non-text parts", () => {
    const content = [
      { type: "text", text: "first" },
      { type: "image", image: "data:..." },
      { type: "text", text: "second" },
    ] as unknown as ModelMessage["content"];
    expect(extractTurnText(content)).toBe("first second");
  });

  it("returns empty string for a content with no text parts", () => {
    const content = [
      { type: "tool-call", toolCallId: "t", toolName: "x", input: {} },
    ] as unknown as ModelMessage["content"];
    expect(extractTurnText(content)).toBe("");
  });
});

describe("buildRecentTurns", () => {
  it("appends the current user+assistant turn to prior history", () => {
    const history: ModelMessage[] = [
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
    ];
    const turns = buildRecentTurns(history, {
      userText: "new question",
      assistantText: "new answer",
    });
    expect(turns).toEqual([
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "new question" },
      { role: "assistant", content: "new answer" },
    ]);
  });

  it("drops system/tool messages and empty turns", () => {
    const history = [
      { role: "system", content: "you are..." },
      { role: "user", content: "  " },
      { role: "tool", content: "tool result" },
      { role: "assistant", content: "kept" },
    ] as unknown as ModelMessage[];
    const turns = buildRecentTurns(history, {
      userText: "q",
      assistantText: "",
    });
    expect(turns).toEqual([
      { role: "assistant", content: "kept" },
      { role: "user", content: "q" },
    ]);
  });

  it("keeps only the last maxTurns and truncates each to maxChars", () => {
    const history: ModelMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "x".repeat(1000),
    }));
    const turns = buildRecentTurns(
      history,
      { userText: "q", assistantText: "a" },
      { maxTurns: 4, maxChars: 10 },
    );
    expect(turns).toHaveLength(4);
    // Last two are the current turn; the earlier two are trailing history.
    expect(turns[2]).toEqual({ role: "user", content: "q" });
    expect(turns[3]).toEqual({ role: "assistant", content: "a" });
    expect(turns[0]!.content.length).toBe(10);
  });

  it("keeps more of the current turn than of history (currentMaxChars)", () => {
    const history: ModelMessage[] = [
      { role: "user", content: "h".repeat(1000) },
    ];
    const turns = buildRecentTurns(
      history,
      { userText: "u".repeat(1000), assistantText: "a".repeat(1000) },
      { maxChars: 100, currentMaxChars: 800 },
    );
    expect(turns[0]!.content.length).toBe(100); // history clipped hard
    expect(turns[1]!.content.length).toBe(800); // current user kept long
    expect(turns[2]!.content.length).toBe(800); // current assistant kept long
  });
});

describe("extractToolActivity", () => {
  it("extracts capability, input preview, and failure reason from tool-call blocks", () => {
    const blocks = [
      { type: "text", text: "hello" },
      {
        type: "tool-call",
        toolCallId: "t1",
        capability: "search_repo",
        inputPreview: { query: "billing meter" },
        status: "success",
      },
      {
        type: "tool-call",
        toolCallId: "t2",
        capability: "put_repo_file",
        inputPreview: "apps/app/src/x.ts",
        status: "error",
        errorReason: "file not found",
      },
      { type: "reasoning", text: "thinking..." },
    ];
    expect(extractToolActivity(blocks)).toEqual([
      { capability: "search_repo", inputPreview: '{"query":"billing meter"}' },
      {
        capability: "put_repo_file",
        inputPreview: "apps/app/src/x.ts",
        errorReason: "file not found",
      },
    ]);
  });

  it("truncates oversized previews and survives unserializable inputs", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const blocks = [
      {
        type: "tool-call",
        capability: "run_query",
        inputPreview: { sql: "SELECT ".padEnd(5000, "x") },
      },
      { type: "tool-call", capability: "weird_tool", inputPreview: circular },
    ];
    const activity = extractToolActivity(blocks);
    expect(activity[0]!.inputPreview!.length).toBeLessThanOrEqual(160);
    // Circular preview is dropped but the capability itself survives.
    expect(activity[1]).toEqual({ capability: "weird_tool" });
  });

  it("returns [] for blocks with no tool calls", () => {
    expect(extractToolActivity([{ type: "text", text: "x" }])).toEqual([]);
  });
});

describe("renderTurnActivity", () => {
  it("renders tool lines with their inputs and failures", () => {
    const rendered = renderTurnActivity([
      { capability: "search_graph", inputPreview: '{"query":"q"}' },
      { capability: "list_executions", errorReason: "permission denied" },
    ]);
    expect(rendered).toContain('search_graph({"query":"q"})');
    expect(rendered).toContain("list_executions — FAILED: permission denied");
  });

  it("caps long lists and reports the overflow count", () => {
    const tools = Array.from({ length: 20 }, (_, i) => ({
      capability: `tool_${i}`,
    }));
    const rendered = renderTurnActivity(tools);
    expect(rendered).toContain("…and 8 more tool calls");
  });

  it("returns empty string when there is nothing to report", () => {
    expect(renderTurnActivity([])).toBe("");
  });
});

describe("generateTurnSuggestions", () => {
  beforeEach(() => {
    generateObjectFor.mockReset();
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 3 trimmed suggestions on success", async () => {
    generateObjectFor.mockResolvedValue({
      object: {
        suggestions: threeSuggestions.map((s) => ({
          label: ` ${s.label} `,
          prompt: ` ${s.prompt} `,
        })),
      },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    const result = await generateTurnSuggestions({
      ...baseInput,
      recentTurns: [{ role: "user", content: "help me build an agent" }],
    });
    expect(result).toEqual(threeSuggestions);
  });

  it("returns null when there are no non-empty recent turns (never calls the model)", async () => {
    const result = await generateTurnSuggestions({
      ...baseInput,
      recentTurns: [{ role: "user", content: "   " }],
    });
    expect(result).toBeNull();
    expect(generateObjectFor).not.toHaveBeenCalled();
  });

  it("fails open (returns null) when the model call throws", async () => {
    generateObjectFor.mockRejectedValue(new Error("model exploded"));
    const result = await generateTurnSuggestions({
      ...baseInput,
      recentTurns: [{ role: "user", content: "x" }],
    });
    expect(result).toBeNull();
  });

  it("returns null when the model returns fewer than 3 usable suggestions", async () => {
    generateObjectFor.mockResolvedValue({
      object: {
        suggestions: [
          { label: "Only One", prompt: "just one" },
          { label: "", prompt: "blank label dropped" },
          { label: "Two", prompt: "" },
        ],
      },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    const result = await generateTurnSuggestions({
      ...baseInput,
      recentTurns: [{ role: "user", content: "x" }],
    });
    expect(result).toBeNull();
  });

  it("grounds the model prompt in tool activity, changed files, and code mode", async () => {
    generateObjectFor.mockResolvedValue({
      object: { suggestions: threeSuggestions },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    await generateTurnSuggestions({
      ...baseInput,
      recentTurns: [{ role: "user", content: "fix the failing route" }],
      toolActivity: [
        {
          capability: "get_execution_trace",
          inputPreview: "exec_42",
          errorReason: "2 steps failed",
        },
      ],
    });
    const args = generateObjectFor.mock.calls[0]![0] as Record<string, unknown>;
    const prompt = args.prompt as string;
    expect(prompt).toContain(
      "get_execution_trace(exec_42) — FAILED: 2 steps failed",
    );
  });

  it("omits the activity section and code-mode steer when absent", async () => {
    generateObjectFor.mockResolvedValue({
      object: { suggestions: threeSuggestions },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    await generateTurnSuggestions({
      ...baseInput,
      recentTurns: [{ role: "user", content: "hello" }],
    });
    const args = generateObjectFor.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.prompt as string).not.toContain("Tool activity this turn:");
    expect(args.system as string).not.toContain("coding session");
  });

  it("forwards telemetry (surface app + messageId) and never enables caching", async () => {
    generateObjectFor.mockResolvedValue({
      object: { suggestions: threeSuggestions },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    await generateTurnSuggestions({
      ...baseInput,
      recentTurns: [{ role: "user", content: "x" }],
    });
    const args = generateObjectFor.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.telemetry).toEqual({
      orgId: "org-1",
      workspaceId: "ws-1",
      surface: "app",
      messageId: baseInput.messageId,
    });
    expect(args.cache).toBeUndefined();
    expect(args.maxRetries).toBe(0);
    expect(args.abortSignal).toBeInstanceOf(AbortSignal);
  });
});
