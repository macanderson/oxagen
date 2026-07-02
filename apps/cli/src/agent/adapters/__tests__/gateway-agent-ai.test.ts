/**
 * Gateway-direct AgentAi adapter tests.
 *
 * Proves (1) the per-vendor reasoning providerOptions mapping matches the
 * canonical `reasoningRequestConfig` semantics from packages/ai/src/stream.ts,
 * (2) construction fails fast with MissingGatewayKeyError when no credential
 * resolves, and (3) stream/generateObject pass gateway slugs and options
 * through to the AI SDK verbatim. The AI SDK itself is mocked — no network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const streamTextMock = vi.fn(() => ({ fullStream: (async function* () {})() }));
const generateObjectMock = vi.fn(async () => ({
  object: { ok: true },
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
}));

vi.mock("ai", () => ({
  streamText: (args: unknown) => streamTextMock(args as never),
  generateObject: (args: unknown) => generateObjectMock(args as never),
}));

vi.mock("../../env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../env.js")>();
  return { ...actual, ensureGatewayKey: vi.fn() };
});

import { ensureGatewayKey, MissingGatewayKeyError } from "../../env.js";
import {
  createGatewayAgentAi,
  gatewayReasoningOptions,
} from "../gateway-agent-ai.js";

const mockEnsureKey = ensureGatewayKey as ReturnType<typeof vi.fn>;

beforeEach(() => {
  streamTextMock.mockClear();
  generateObjectMock.mockClear();
  mockEnsureKey.mockReturnValue("test-gateway-key");
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── gatewayReasoningOptions (per-vendor mapping) ─────────────────────────────

describe("gatewayReasoningOptions", () => {
  it("returns undefined when no effort is requested", () => {
    expect(gatewayReasoningOptions("anthropic/claude-opus-4-8", undefined)).toBeUndefined();
  });

  it("maps anthropic to adaptive thinking + outputConfig effort", () => {
    expect(gatewayReasoningOptions("anthropic/claude-opus-4-8", "xhigh")).toEqual({
      anthropic: {
        thinking: { type: "adaptive" },
        outputConfig: { effort: "xhigh" },
      },
    });
  });

  it("maps openai to reasoningEffort clamped to high, with detailed summary", () => {
    expect(gatewayReasoningOptions("openai/gpt-5.2", "max")).toEqual({
      openai: { reasoningEffort: "high", reasoningSummary: "detailed" },
    });
    expect(gatewayReasoningOptions("openai/gpt-5.2", "low")).toEqual({
      openai: { reasoningEffort: "low", reasoningSummary: "detailed" },
    });
  });

  it("maps google to thinkingConfig with the effort's token budget", () => {
    expect(gatewayReasoningOptions("google/gemini-3-pro", "medium")).toEqual({
      google: {
        thinkingConfig: { includeThoughts: true, thinkingBudget: 8192 },
      },
    });
  });

  it("maps xai to a clamped reasoningEffort", () => {
    expect(gatewayReasoningOptions("xai/grok-4", "xhigh")).toEqual({
      xai: { reasoningEffort: "high" },
    });
  });

  it("returns undefined for deepseek (native reasoning, no knob)", () => {
    expect(gatewayReasoningOptions("deepseek/deepseek-r2", "high")).toBeUndefined();
  });

  it("falls back to the openai namespace for unknown vendors and bare slugs", () => {
    expect(gatewayReasoningOptions("mistral/large-3", "high")).toEqual({
      openai: { reasoningEffort: "high" },
    });
    expect(gatewayReasoningOptions("bare-slug", "medium")).toEqual({
      openai: { reasoningEffort: "medium" },
    });
  });
});

// ── createGatewayAgentAi ─────────────────────────────────────────────────────

describe("createGatewayAgentAi", () => {
  it("throws MissingGatewayKeyError when no credential resolves", () => {
    mockEnsureKey.mockReturnValue(null);
    expect(() => createGatewayAgentAi()).toThrow(MissingGatewayKeyError);
  });

  it("stream passes the gateway slug, tools, and reasoning providerOptions to streamText", () => {
    const ai = createGatewayAgentAi();
    const args = {
      model: "anthropic/claude-opus-4-8",
      system: "sys",
      messages: [{ role: "user" as const, content: "hi" }],
      tools: { bash: {} },
      effort: "high" as const,
    };
    ai.stream(args as never);

    expect(streamTextMock).toHaveBeenCalledTimes(1);
    const call = streamTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call["model"]).toBe("anthropic/claude-opus-4-8");
    expect(call["system"]).toBe("sys");
    expect(call["tools"]).toEqual({ bash: {} });
    expect(call["providerOptions"]).toEqual({
      anthropic: { thinking: { type: "adaptive" }, outputConfig: { effort: "high" } },
    });
  });

  it("stream omits providerOptions entirely when no effort is set", () => {
    const ai = createGatewayAgentAi();
    ai.stream({
      model: "anthropic/claude-opus-4-8",
      messages: [],
    } as never);
    const call = streamTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("providerOptions" in call).toBe(false);
  });

  it("generateObject passes messages XOR prompt and returns object + usage", async () => {
    const ai = createGatewayAgentAi();
    const res = await ai.generateObject({
      model: "openai/gpt-5.2",
      schema: {} as never,
      prompt: "classify",
    } as never);

    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    const call = generateObjectMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call["model"]).toBe("openai/gpt-5.2");
    expect(call["prompt"]).toBe("classify");
    expect("messages" in call).toBe(false);
    expect(res.object).toEqual({ ok: true });
    expect(res.usage.totalTokens).toBe(15);
  });

  it("generateObject prefers messages when provided", async () => {
    const ai = createGatewayAgentAi();
    await ai.generateObject({
      model: "openai/gpt-5.2",
      schema: {} as never,
      messages: [{ role: "user", content: "hi" }],
    } as never);
    const call = generateObjectMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call["messages"]).toEqual([{ role: "user", content: "hi" }]);
    expect("prompt" in call).toBe(false);
  });
});
