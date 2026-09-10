/**
 * The governed turn on the engine, against the client package's fake engine.
 *
 * `streamAgentReply` is mocked at the chokepoint, as the old loop's tests
 * mocked it, so what these cases pin is the answerer: every completion the
 * engine asks for goes through the chokepoint with the funding facts, every
 * tool the engine asks for runs through the materialised `execute`, and the
 * parts the routes read come out in the vocabulary their translators switch
 * on. The engine itself is the fake replaying a turn recorded against the
 * real binary; the smoke test in the client package keeps the fake honest.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CREDIT_REASONS } from "@oxagen/billing";
import {
  StellaEngineClient,
  type ServerFrame,
} from "@oxagen/stella-engine-client";
import { FakeEngine, goldenScript } from "@oxagen/stella-engine-client/testing";

const streamAgentReply = vi.fn();
const selectModel = vi.fn((s: { tier?: string }) => ({
  modelId: `model-for-${s.tier ?? "default"}`,
}));

vi.mock("@oxagen/ai", () => ({
  streamAgentReply: (args: unknown) => streamAgentReply(args),
  defaultModel: () => ({ modelId: "default-model" }),
  modelIdOf: (m: unknown) =>
    typeof m === "string" ? m : ((m as { modelId?: string }).modelId ?? ""),
  selectModel: (s: { tier?: string }) => selectModel(s),
  stepCountIs: (n: number) => ({ __stepCountIs: n }),
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => ({
    STELLA_SERVE_URL: "http://engine.test",
    STELLA_SERVE_TOKEN: "fake-token",
  }),
}));

import {
  ENGINE_PROVIDER_ID,
  ENGINE_REVERSE_REQUEST_TIMEOUT_MS,
  EngineUnavailableError,
  aggregateStepUsage,
  buildTurnUserMessage,
  runGovernedTurn,
  serializeMutatingTools,
} from "./governed-turn";
import { modelForRole } from "./engine/provider";

interface FakeStreamOptions {
  text?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    inputTokenDetails?: { cacheReadTokens?: number };
  };
  finishReason?: string;
  deltas?: string[];
}

function fakeStream(options: FakeStreamOptions = {}) {
  const deltas = options.deltas ?? [];
  return {
    fullStream: (async function* () {
      for (const text of deltas) yield { type: "text-delta", id: "t", text };
    })(),
    text: Promise.resolve(options.text ?? ""),
    toolCalls: Promise.resolve(options.toolCalls ?? []),
    usage: Promise.resolve(
      options.usage ?? { inputTokens: 10, outputTokens: 5 },
    ),
    finishReason: Promise.resolve(
      options.finishReason ??
        (options.toolCalls?.length ? "tool-calls" : "stop"),
    ),
  };
}

function setup(script: ServerFrame[] = goldenScript()) {
  const engine = new FakeEngine();
  engine.scriptTurn(script);
  const client = new StellaEngineClient({
    baseUrl: "http://engine.test",
    token: "fake-token",
    fetchImpl: engine.fetch,
  });
  return { engine, client };
}

async function drain(result: {
  fullStream: AsyncIterable<unknown>;
}): Promise<Array<{ type: string } & Record<string, unknown>>> {
  const parts: Array<{ type: string } & Record<string, unknown>> = [];
  for await (const part of result.fullStream)
    parts.push(part as { type: string } & Record<string, unknown>);
  return parts;
}

const telemetry = {
  orgId: "org-1",
  workspaceId: "ws-1",
  surface: "app" as const,
  messageId: "11111111-1111-4111-8111-111111111111",
};

describe("runGovernedTurn on the engine", () => {
  beforeEach(() => {
    streamAgentReply.mockReset();
    selectModel.mockClear();
    // First completion asks for the tool, second answers.
    streamAgentReply
      .mockImplementationOnce(() =>
        fakeStream({
          toolCalls: [
            {
              toolCallId: "call_1",
              toolName: "search_nodes",
              input: { q: "nodes" },
            },
          ],
        }),
      )
      .mockImplementationOnce(() =>
        fakeStream({
          text: "There are 3 nodes.",
          deltas: ["There are ", "3 nodes."],
          usage: {
            inputTokens: 20,
            outputTokens: 6,
            inputTokenDetails: { cacheReadTokens: 4 },
          },
        }),
      );
  });

  it("answers both ports and yields the parts the translators read", async () => {
    const { engine, client } = setup();
    const execute = vi.fn(async (_input: unknown) => ({
      rows: ["n1", "n2", "n3"],
    }));
    const result = await runGovernedTurn({
      telemetry,
      model: { modelId: "anthropic/claude-sonnet-4.6" } as never,
      tier: "balanced",
      system: "GOVERNANCE PROMPT",
      history: [
        { role: "user", content: "earlier" },
        { role: "assistant", content: "before" },
      ],
      contextMessages: [null, { role: "user", content: "[memory]" }],
      instruction: "list the nodes",
      tools: {
        search_nodes: {
          description: "Search graph nodes",
          inputSchema: {
            type: "object",
            properties: { q: { type: "string" } },
          } as never,
          execute,
        } as never,
      },
      governance: {
        search_nodes: {
          riskLevel: "low",
          requiresApproval: false,
          readOnly: true,
        },
      },
      principal: "user-1",
      fundedBy: "org",
      engine: client,
    });

    const parts = await drain(result);
    expect(parts.map((p) => p.type)).toEqual([
      "start-step",
      "tool-call",
      "tool-result",
      "text-delta",
      "finish-step",
      "finish",
    ]);
    expect(parts.find((p) => p.type === "tool-result")).toMatchObject({
      toolCallId: "call_1",
      output: { rows: ["n1", "n2", "n3"] },
    });
    expect(await result.finalText).toBe("There are 3 nodes.");
    expect(await result.usage).toEqual({
      inputTokens: 30,
      outputTokens: 11,
      totalTokens: 41,
      cachedInputTokens: 4,
    });
    expect(result.modelId).toBe("anthropic/claude-sonnet-4.6");
    expect(result.fundedBy).toBe("org");
    expect(result.budgeted).toBe(false);
    expect(result.maxSteps).toBe(12);
    await expect(result.turnId).resolves.toMatch(/^turn-/);

    // The tool ran once, through its own execute, with the engine's request id as the call id.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toEqual({ q: "nodes" });

    // Both completions went through the chokepoint with the funding facts and a single-step cap.
    expect(streamAgentReply).toHaveBeenCalledTimes(2);
    for (const call of streamAgentReply.mock.calls) {
      const args = call[0] as Record<string, unknown>;
      expect(args.fundedBy).toBe("org");
      expect(args.chargeReason).toBe(CREDIT_REASONS.CONSUME_ASSISTANT_TOKENS);
      expect(args.stopWhen).toEqual({ __stepCountIs: 1 });
      expect(args.telemetry).toEqual(telemetry);
      expect(args.system).toBe("GOVERNANCE PROMPT");
      // Schemas only: the SDK must never execute a tool itself.
      expect(
        (args.tools as Record<string, { execute?: unknown }>).search_nodes
          ?.execute,
      ).toBeUndefined();
    }

    // The engine was told who is acting, what the tools are, and how long to wait for us.
    const request = engine.turnRequests[0] as Record<string, unknown>;
    expect(request.provider_id).toBe(ENGINE_PROVIDER_ID);
    expect(request.principal).toBe("user-1");
    expect(request.max_steps).toBe(12);
    expect(request.reverse_request_timeout_ms).toBe(
      ENGINE_REVERSE_REQUEST_TIMEOUT_MS,
    );
    expect(request.tools).toEqual([
      expect.objectContaining({
        version: 1,
        risk: "low",
        requires_approval: false,
        provenance: "declared",
        schema: expect.objectContaining({
          name: "search_nodes",
          read_only: true,
        }),
      }),
    ]);
    // The transcript: system, history, context (null dropped), then the instruction.
    expect(
      (request.messages as Array<{ role: string; content?: string }>).map(
        (m) => [m.role, m.content],
      ),
    ).toEqual([
      ["system", "GOVERNANCE PROMPT"],
      ["user", "earlier"],
      ["assistant", "before"],
      ["user", "[memory]"],
      ["user", "list the nodes"],
    ]);
    // The streamed deltas reached the engine as provider-delta batches.
    expect(
      engine.posts.filter((p) => p.route === "provider-delta").length,
    ).toBeGreaterThan(0);
  });

  it("defaults to platform funding and the assistant charge reason", async () => {
    const { client } = setup();
    const result = await runGovernedTurn({
      telemetry,
      system: "s",
      history: [],
      instruction: "hi",
      tools: {
        search_nodes: {
          description: "d",
          inputSchema: { type: "object" } as never,
          execute: async () => "ok",
        } as never,
      },
      engine: client,
    });
    await drain(result);
    expect(result.fundedBy).toBe("platform");
    expect(
      (streamAgentReply.mock.calls[0]![0] as Record<string, unknown>).fundedBy,
    ).toBe("platform");
    expect(
      (streamAgentReply.mock.calls[0]![0] as Record<string, unknown>)
        .chargeReason,
    ).toBe("consume_assistant_tokens");
  });

  it("throws EngineUnavailableError before streaming when the engine is not ready", async () => {
    const engine = new FakeEngine({ readiness: "starting" });
    const client = new StellaEngineClient({
      baseUrl: "http://engine.test",
      token: "fake-token",
      fetchImpl: engine.fetch,
    });
    await expect(
      runGovernedTurn({
        telemetry,
        system: "s",
        history: [],
        instruction: "hi",
        tools: {},
        engine: client,
      }),
    ).rejects.toBeInstanceOf(EngineUnavailableError);
    expect(streamAgentReply).not.toHaveBeenCalled();
  });

  it("throws EngineUnavailableError when the engine cannot be reached at all", async () => {
    const client = new StellaEngineClient({
      baseUrl: "http://engine.test",
      token: "t",
      fetchImpl: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        });
      },
    });
    const err = await runGovernedTurn({
      telemetry,
      system: "s",
      history: [],
      instruction: "hi",
      tools: {},
      engine: client,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect((err as Error).message).toMatch(/assistant engine is unavailable/);
  });

  it("renders a thrown tool as a tool-error part and tells the engine it was refused", async () => {
    const { engine, client } = setup();
    const result = await runGovernedTurn({
      telemetry,
      system: "s",
      history: [],
      instruction: "hi",
      tools: {
        search_nodes: {
          description: "d",
          inputSchema: { type: "object" } as never,
          execute: async () => {
            throw new Error("approval denied for search_nodes");
          },
        } as never,
      },
      engine: client,
    });
    const parts = await drain(result);
    expect(parts.find((p) => p.type === "tool-error")).toMatchObject({
      toolCallId: "call_1",
      toolName: "search_nodes",
    });
    const answer = engine.posts.find((p) => p.route === "tool-result")!
      .body as { output: unknown };
    expect(answer.output).toEqual({
      error: {
        message: "approval denied for search_nodes",
        class: "refused_by_policy",
      },
    });
  });

  it("cancels the engine turn when the budget guard says stop", async () => {
    const { engine, client } = setup();
    const result = await runGovernedTurn({
      telemetry,
      system: "s",
      history: [],
      instruction: "hi",
      tools: {
        search_nodes: {
          description: "d",
          inputSchema: { type: "object" } as never,
          execute: async () => "ok",
        } as never,
      },
      budgetGuard: () => "stop",
      engine: client,
    });
    expect(result.budgeted).toBe(true);
    const parts = await drain(result);
    expect(parts.at(-2)).toMatchObject({
      type: "error",
      error: expect.objectContaining({ code: "engine_aborted" }),
    });
    expect(parts.at(-1)).toMatchObject({
      type: "finish",
      finishReason: "error",
    });
    expect(streamAgentReply).not.toHaveBeenCalled();
    expect(engine.turnRequests[0]).toMatchObject({
      budget: { mode: "observed" },
    });
  });

  it("cancels the engine turn when the caller aborts, and ends the stream", async () => {
    const { client } = setup();
    const controller = new AbortController();
    streamAgentReply.mockReset().mockImplementation(() => {
      controller.abort();
      return fakeStream({ text: "late" });
    });
    const result = await runGovernedTurn({
      telemetry,
      system: "s",
      history: [],
      instruction: "hi",
      tools: {},
      abortSignal: controller.signal,
      engine: client,
    });
    const parts = await drain(result);
    expect(parts.at(-1)).toMatchObject({
      type: "finish",
      finishReason: "error",
    });
  });

  it("routes the verdict role to a model that is not the worker's", () => {
    const worker = { modelId: "worker" } as never;
    expect(
      modelForRole("worker", { model: worker, workerTier: "balanced" }).modelId,
    ).toBe("worker");
    expect(
      modelForRole("verdict", { model: worker, workerTier: "balanced" })
        .modelId,
    ).toBe("model-for-precise");
    expect(
      modelForRole("verdict", { model: worker, workerTier: "precise" }).modelId,
    ).toBe("model-for-balanced");
    expect(
      modelForRole("summarization", { model: worker, workerTier: "balanced" })
        .modelId,
    ).toBe("model-for-fast");
    expect(
      modelForRole("something_new", { model: worker, workerTier: "balanced" })
        .modelId,
    ).toBe("worker");
  });
});

describe("helpers", () => {
  it("aggregates step usage including prompt-cache reads", () => {
    expect(
      aggregateStepUsage([
        {
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            totalTokens: 3,
            inputTokenDetails: { cacheReadTokens: 1 },
          },
        },
        {
          usage: {
            inputTokens: 4,
            outputTokens: 5,
            totalTokens: 9,
            cachedInputTokens: 2,
          },
        },
        {},
      ]),
    ).toEqual({
      inputTokens: 5,
      outputTokens: 7,
      totalTokens: 12,
      cachedInputTokens: 3,
    });
  });

  it("builds a user message with image and file parts", () => {
    const bytes = new Uint8Array([1, 2]);
    expect(buildTurnUserMessage("hi")).toEqual({ role: "user", content: "hi" });
    expect(
      buildTurnUserMessage("look", [
        { kind: "image", data: bytes, mediaType: "image/png" },
        { kind: "file", data: bytes, mediaType: "video/mp4" },
      ]),
    ).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", image: bytes, mediaType: "image/png" },
        { type: "file", data: bytes, mediaType: "video/mp4" },
      ],
    });
  });

  it("serialises mutating tools and leaves the rest concurrent", async () => {
    const order: string[] = [];
    const slow = async (name: string, ms: number) => {
      order.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name}:end`);
      return name;
    };
    const tools = {
      write_a: { execute: () => slow("a", 20) },
      write_b: { execute: () => slow("b", 5) },
      read_c: { execute: () => slow("c", 5) },
    } as never;
    const out = serializeMutatingTools(tools, ["write_a", "write_b"]) as Record<
      string,
      { execute: (i: unknown, o: unknown) => Promise<string> }
    >;
    await Promise.all([
      out.write_a!.execute({}, {}),
      out.write_b!.execute({}, {}),
      out.read_c!.execute({}, {}),
    ]);
    expect(order.indexOf("b:start")).toBeGreaterThan(order.indexOf("a:end"));
    expect(order.indexOf("c:start")).toBeLessThan(order.indexOf("a:end"));
    expect(serializeMutatingTools(tools, [])).toBe(tools);
  });
});
