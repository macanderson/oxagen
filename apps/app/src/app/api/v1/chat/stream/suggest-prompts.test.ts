import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";

// Mock the metered AI port so no real model is called. `generateObjectFor` is
// the only LLM entry point; `selectModel` just returns an opaque handle.
const generateObjectFor = vi.fn();
vi.mock("@oxagen/ai", () => ({
  generateObjectFor: (...args: unknown[]) => generateObjectFor(...args),
  selectModel: () => "fast-model" as unknown,
}));

// Silence the best-effort warn logger.
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  buildRecentTurns,
  extractTurnText,
  generateTurnSuggestions,
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
    const turns = buildRecentTurns(history, { userText: "q", assistantText: "" });
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
