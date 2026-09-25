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
import { digestJcs } from "@oxagen/run-evidence";
import { z } from "zod";

const streamAgentReply = vi.fn();
const selectModel = vi.fn((s: { tier?: string }) => ({
  modelId: `model-for-${s.tier ?? "default"}`,
}));

vi.mock("@oxagen/ai", () => ({
  tool: (def: unknown) => def,
  streamAgentReply: (args: unknown) => streamAgentReply(args),
  defaultModel: () => ({ modelId: "default-model" }),
  modelIdOf: (m: unknown) =>
    typeof m === "string" ? m : ((m as { modelId?: string }).modelId ?? ""),
  // `modelIdentityFor` in miniature: the credential names who serves the
  // turn, which is what the provider tool ceilings are found by when the wire
  // id carries no vendor prefix.
  modelIdentityFor: (
    wireId: string,
    credential?: { provider?: string } | undefined,
  ) => ({
    wireId,
    catalogId: wireId,
    provider:
      credential?.provider ??
      (wireId.includes("/") ? (wireId.split("/")[0] ?? null) : null),
  }),
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
  ModelCallFailedError,
  aggregateStepUsage,
  buildTurnUserMessage,
  runGovernedTurn,
  serializeMutatingTools,
  type TurnLedger,
  type TurnLedgerModelCall,
  type TurnLedgerModelIntent,
  type TurnLedgerOutcome,
  type TurnLedgerToolCall,
  type TurnLedgerToolIntent,
} from "./governed-turn";
import { ApprovalPendingError } from "./approval-pending";
import { modelForRole } from "./engine/provider";
import { LOAD_TOOLS, SEARCH_TOOLS, createToolBelt } from "./tool-belt";

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

  it("records the provider request the budget stopped, as cancelled", async () => {
    // A run sealed `cancelled` with no receipt for the request that hit the
    // budget cannot show why it stopped, which is the one thing a customer
    // disputing a bill asks for. The event schema already carries `cancelled`.
    const { client } = setup();
    const modelCalls: TurnLedgerModelCall[] = [];
    const outcomes: TurnLedgerOutcome[] = [];
    const result = await runGovernedTurn({
      telemetry,
      system: "s",
      history: [],
      instruction: "hi",
      tools: {},
      budgetGuard: () => "stop",
      engine: client,
      ledger: {
        modelCallStarted: async () => undefined,
        modelCall: async (record) => {
          modelCalls.push(record);
        },
        toolCallStarted: async () => undefined,
        toolCall: async () => undefined,
        seal: async (outcome) => {
          outcomes.push(outcome);
        },
      },
    });
    await drain(result);
    expect(modelCalls).toHaveLength(1);
    expect(modelCalls[0]).toMatchObject({ outcome: "cancelled" });
    expect(modelCalls[0]!.requestId).toBeTruthy();
    expect(outcomes.map((o) => o.status)).toEqual(["aborted"]);
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

  it("records every answered reverse request on the ledger before answering it, then seals", async () => {
    const { engine, client } = setup();
    const log: string[] = [];
    const modelCalls: TurnLedgerModelCall[] = [];
    const toolCalls: TurnLedgerToolCall[] = [];
    const outcomes: TurnLedgerOutcome[] = [];
    const ledger: TurnLedger = {
      modelCallStarted: async () => undefined,
      modelCall: async (record) => {
        log.push(`model:${record.requestId}`);
        modelCalls.push(record);
      },
      toolCallStarted: async () => undefined,
      toolCall: async (record) => {
        log.push(`tool:${record.requestId}`);
        toolCalls.push(record);
      },
      seal: async (outcome) => {
        log.push(`seal:${outcome.status}`);
        outcomes.push(outcome);
      },
    };
    const originalFetch = engine.fetch;
    const posted: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (init?.method === "POST" && /provider-result|tool-result/.test(url))
        posted.push(`post:${url.split("/").at(-1)}`);
      // The receipt for a request is written before its answer is posted.
      if (url.endsWith("provider-result") || url.endsWith("tool-result")) {
        expect(log.length).toBeGreaterThan(posted.length - 1);
      }
      return originalFetch(input, init);
    };
    const recordingClient = new StellaEngineClient({
      baseUrl: "http://engine.test",
      token: "fake-token",
      fetchImpl,
    });
    void client;
    const result = await runGovernedTurn({
      telemetry,
      model: { modelId: "anthropic/claude-sonnet-4.6" } as never,
      system: "s",
      history: [],
      instruction: "list the nodes",
      tools: {
        search_nodes: {
          description: "d",
          inputSchema: { type: "object" } as never,
          execute: async () => ({ rows: 3 }),
        } as never,
      },
      engine: recordingClient,
      ledger,
    });
    await drain(result);
    expect(await result.finalText).toBe("There are 3 nodes.");

    // One receipt per reverse request, in the engine's order, each carrying
    // the frame's seq; the seal is the last write.
    expect(log).toEqual([
      "model:prov-1-0",
      "tool:tool-1-0",
      "model:prov-1-1",
      "seal:completed",
    ]);
    // The provider is what the engine's frame echoed (the golden recording's
    // id), the seq is the frame's own.
    expect(modelCalls[0]).toMatchObject({
      seq: 1,
      role: "worker",
      provider: "openrouter",
      outcome: "completed",
      usage: expect.objectContaining({ input_tokens: 10, output_tokens: 5 }),
    });
    expect(modelCalls[1]).toMatchObject({ seq: 5, outcome: "completed" });
    expect(toolCalls[0]).toMatchObject({
      seq: 3,
      toolName: "search_nodes",
      outcome: "completed",
      // The receipt carries what the engine was answered with.
      output: { ok: { content: '{"rows":3}' } },
    });
    expect(outcomes).toEqual([
      { status: "completed", text: "There are 3 nodes." },
    ]);
  });

  it("records the intention before the tool runs, under the canonical capability name", async () => {
    // Two defects in one place. The receipt used to be written only AFTER the
    // tool had run, so a mutating tool whose side effect committed and whose
    // receipt then failed to append left evidence asserting it never
    // happened. And it was keyed on the model-facing alias, which for an
    // external MCP tool is sanitized and can be collision-suffixed, so the
    // evidence could not be joined back to the capability that was
    // authorized.
    const { client } = setup();
    const log: string[] = [];
    const intents: TurnLedgerToolIntent[] = [];
    const toolCalls: TurnLedgerToolCall[] = [];
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
            log.push("exec");
            return "ok";
          },
        } as never,
      },
      // As materializeTools builds it: alias → canonical capability name.
      toolNameMap: { search_nodes: "query_ontology" },
      engine: client,
      ledger: {
        modelCallStarted: async () => undefined,
        modelCall: async () => undefined,
        toolCallStarted: async (record) => {
          log.push("start");
          intents.push(record);
        },
        toolCall: async (record) => {
          log.push("done");
          toolCalls.push(record);
        },
        seal: async () => undefined,
      },
    });
    await drain(result);
    // The intention is durable before the side effect can happen.
    expect(log).toEqual(["start", "exec", "done"]);
    // Identity is the canonical name on both events; the alias rides beside
    // it and is never the identifier.
    expect(intents[0]).toMatchObject({
      toolName: "query_ontology",
      toolAlias: "search_nodes",
    });
    expect(toolCalls[0]).toMatchObject({
      toolName: "query_ontology",
      toolAlias: "search_nodes",
      outcome: "completed",
    });
  });

  it("never invokes a tool whose intention could not be recorded", async () => {
    // The write-ahead guarantee only holds if a failed intention stops the
    // call: otherwise the mutation happens with nothing durable about it.
    const { client } = setup();
    const execute = vi.fn(async () => "ok");
    const outcomes: TurnLedgerOutcome[] = [];
    const result = await runGovernedTurn({
      telemetry,
      system: "s",
      history: [],
      instruction: "hi",
      tools: {
        search_nodes: {
          description: "d",
          inputSchema: { type: "object" } as never,
          execute,
        } as never,
      },
      engine: client,
      ledger: {
        modelCallStarted: async () => undefined,
        modelCall: async () => undefined,
        toolCallStarted: async () => {
          throw new Error("ledger is read-only");
        },
        toolCall: async () => undefined,
        seal: async (outcome) => {
          outcomes.push(outcome);
        },
      },
    });
    await drain(result);
    // The mutation never happened, which is the guarantee.
    expect(execute).not.toHaveBeenCalled();
    // And the turn does not answer: a receipt that cannot be written cancels
    // the turn and rejects it, the same as every other receipt in this file.
    expect(outcomes.map((o) => o.status)).toEqual(["aborted"]);
    await expect(result.finalText).rejects.toThrow("ledger is read-only");
  });

  it("records the model-call intention before the provider is contacted", async () => {
    // The mirror of the tool write-ahead above, and for the same reason: the
    // provider bills for a completion the moment it answers, so a run whose
    // only model append is the terminal one can be sealed with evidence that
    // omits a charge the customer has already been metered for.
    const { client } = setup();
    const log: string[] = [];
    const intents: TurnLedgerModelIntent[] = [];
    const modelCalls: TurnLedgerModelCall[] = [];
    streamAgentReply.mockReset();
    streamAgentReply
      .mockImplementationOnce(() => {
        log.push("provider");
        return fakeStream({ text: "", finishReason: "stop" });
      })
      .mockImplementation(() => {
        log.push("provider");
        return fakeStream({ text: "done", finishReason: "stop" });
      });
    const result = await runGovernedTurn({
      telemetry,
      model: { modelId: "anthropic/claude-sonnet-4.6" } as never,
      system: "s",
      history: [],
      instruction: "hi",
      tools: {},
      engine: client,
      ledger: {
        modelCallStarted: async (record) => {
          log.push("start");
          intents.push(record);
        },
        modelCall: async (record) => {
          log.push("done");
          modelCalls.push(record);
        },
        toolCallStarted: async () => undefined,
        toolCall: async () => undefined,
        seal: async () => undefined,
      },
    });
    await drain(result);

    // The intention is durable before the tokens can be incurred.
    expect(log.slice(0, 3)).toEqual(["start", "provider", "done"]);
    // One intention per completion, never more: a started event is not a call.
    expect(intents).toHaveLength(modelCalls.length);
    // The intention names the frame the completed event names, so the two
    // join, and carries the CONFIGURED model — the provider has not resolved
    // one yet. The completed event carries the resolved id, and the pair read
    // together is what shows a gateway substitution.
    expect(intents[0]).toMatchObject({
      seq: modelCalls[0]?.seq,
      requestId: modelCalls[0]?.requestId,
      role: "worker",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.6",
    });
    expect(intents[0]).not.toHaveProperty("outcome");
    expect(intents[0]).not.toHaveProperty("usage");
  });

  it("never contacts the provider when the model-call intention could not be recorded", async () => {
    // The write-ahead guarantee only holds if a failed intention stops the
    // request: otherwise the tokens are spent with nothing durable about them.
    const { client } = setup();
    const outcomes: TurnLedgerOutcome[] = [];
    const result = await runGovernedTurn({
      telemetry,
      system: "s",
      history: [],
      instruction: "hi",
      tools: {},
      engine: client,
      ledger: {
        modelCallStarted: async () => {
          throw new Error("ledger is read-only");
        },
        modelCall: async () => undefined,
        toolCallStarted: async () => undefined,
        toolCall: async () => undefined,
        seal: async (outcome) => {
          outcomes.push(outcome);
        },
      },
    });
    await drain(result);

    // No completion was ever asked for, which is the guarantee.
    expect(streamAgentReply).not.toHaveBeenCalled();
    expect(outcomes.map((o) => o.status)).toEqual(["aborted"]);
    await expect(result.finalText).rejects.toThrow("ledger is read-only");
  });

  it("records a refused tool as denied on the ledger", async () => {
    const { client } = setup();
    const toolCalls: TurnLedgerToolCall[] = [];
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
      ledger: {
        modelCallStarted: async () => undefined,
        modelCall: async () => undefined,
        toolCallStarted: async () => undefined,
        toolCall: async (record) => {
          toolCalls.push(record);
        },
        seal: async () => undefined,
      },
    });
    await drain(result);
    expect(toolCalls).toEqual([
      expect.objectContaining({
        toolName: "search_nodes",
        outcome: "denied",
        error: "approval denied for search_nodes",
      }),
    ]);
  });

  it("records a call parked for approval as parked, naming its approval", async () => {
    // The park used to read as `denied`: the engine is answered
    // `refused_by_policy`, and the outcome was read off that class alone.
    const { engine, client } = setup();
    const toolCalls: TurnLedgerToolCall[] = [];
    const result = await runGovernedTurn({
      telemetry,
      system: "s",
      history: [],
      instruction: "hi",
      tools: {
        search_nodes: {
          description: "d",
          inputSchema: { type: "object" } as never,
          // What materializeTools throws under `approvalMode: "park"`.
          execute: async () => {
            throw new ApprovalPendingError(
              "create_workspace",
              "0192f0c4-0000-7000-8000-000000000001",
              "2026-09-25T12:05:00.000Z",
              "apr_0a1b2c3d4e5f6g7h8j9k0m",
            );
          },
        } as never,
      },
      engine: client,
      ledger: {
        modelCallStarted: async () => undefined,
        modelCall: async () => undefined,
        toolCallStarted: async () => undefined,
        toolCall: async (record) => {
          toolCalls.push(record);
        },
        seal: async () => undefined,
      },
    });
    await drain(result);
    // The engine's vocabulary has no wait, so it is still told a refusal.
    const answer = engine.posts.find((p) => p.route === "tool-result")!
      .body as { output: { error: { class?: string } } };
    expect(answer.output.error.class).toBe("refused_by_policy");
    expect(toolCalls).toEqual([
      expect.objectContaining({
        toolName: "search_nodes",
        outcome: "parked",
        approvalPublicId: "apr_0a1b2c3d4e5f6g7h8j9k0m",
        error: expect.stringContaining("is waiting for approval"),
      }),
    ]);
  });

  it("records a parked call with no public id as parked, naming nothing", async () => {
    const { client } = setup();
    const toolCalls: TurnLedgerToolCall[] = [];
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
            throw new ApprovalPendingError(
              "create_workspace",
              "0192f0c4-0000-7000-8000-000000000001",
              "2026-09-25T12:05:00.000Z",
            );
          },
        } as never,
      },
      engine: client,
      ledger: {
        modelCallStarted: async () => undefined,
        modelCall: async () => undefined,
        toolCallStarted: async () => undefined,
        toolCall: async (record) => {
          toolCalls.push(record);
        },
        seal: async () => undefined,
      },
    });
    await drain(result);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.outcome).toBe("parked");
    expect(toolCalls[0]).not.toHaveProperty("approvalPublicId");
  });

  it("cancels the turn and does not answer when a receipt cannot be written", async () => {
    const { engine, client } = setup();
    const outcomes: TurnLedgerOutcome[] = [];
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
      ledger: {
        modelCallStarted: async () => undefined,
        modelCall: async () => {
          throw new Error("ledger is read-only");
        },
        toolCallStarted: async () => undefined,
        toolCall: async () => undefined,
        seal: async (outcome) => {
          outcomes.push(outcome);
        },
      },
    });
    const parts = await drain(result);
    expect(parts.at(-1)).toMatchObject({
      type: "finish",
      finishReason: "error",
    });
    // The first completion's answer never reached the engine, and the turn
    // was cancelled instead of continued from an unrecorded step.
    const answers = engine.posts
      .filter((p) => p.route === "provider-result")
      .map((p) => (p.body as { status: string }).status);
    expect(answers).toEqual(["error"]);
    expect(outcomes.map((o) => o.status)).toEqual(["aborted"]);
    // A turn that could not be recorded does not answer: the result promises
    // reject with the receipt's failure instead of resolving the aborted text.
    await expect(result.finalText).rejects.toThrow("ledger is read-only");
    await expect(result.usage).rejects.toThrow("ledger is read-only");
  });

  it("writes the receipt for a load_tools call over zod schemas, and the model is shown the loaded tool", async () => {
    const script = goldenScript().map((frame) =>
      frame.type === "tool_request"
        ? { ...frame, name: LOAD_TOOLS, input: { names: ["search_nodes"] } }
        : frame,
    ) as ServerFrame[];
    const { client } = setup(script);
    const belt = createToolBelt({
      tools: {
        search_nodes: {
          description: "Search graph nodes",
          inputSchema: z.object({ q: z.string() }),
          execute: async () => ({ rows: 3 }),
        },
      } as never,
      pinned: [],
      modelId: "anthropic/claude-sonnet-4.6",
    });
    const receipts: Array<{ toolName: string; outputDigest: string }> = [];
    const outcomes: TurnLedgerOutcome[] = [];
    const result = await runGovernedTurn({
      telemetry,
      model: { modelId: "anthropic/claude-sonnet-4.6" } as never,
      system: "s",
      history: [],
      instruction: "list the nodes",
      tools: belt.tools,
      modelTools: belt.modelTools,
      governance: belt.governance,
      engine: client,
      ledger: {
        modelCallStarted: async () => undefined,
        modelCall: async () => undefined,
        // The recorder digests the receipt synchronously while building it.
        toolCallStarted: async () => undefined,
        toolCall: (record) => {
          receipts.push({
            toolName: record.toolName,
            outputDigest: digestJcs(record.output ?? null),
          });
          return Promise.resolve();
        },
        seal: async (outcome) => {
          outcomes.push(outcome);
        },
      },
    });
    await drain(result);
    expect(await result.finalText).toBe("There are 3 nodes.");
    expect(receipts).toEqual([
      { toolName: LOAD_TOOLS, outputDigest: expect.stringMatching(/^sha256:/) },
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(["completed"]);
    const shown = streamAgentReply.mock.calls.map((call) =>
      Object.keys((call[0] as { tools: Record<string, unknown> }).tools).sort(),
    );
    expect(shown[1]).toEqual([LOAD_TOOLS, SEARCH_TOOLS, "search_nodes"].sort());
  });

  it("writes the receipt for a tool whose output is not plain JSON (an undefined field, a Date)", async () => {
    const { client } = setup();
    const digests: string[] = [];
    const result = await runGovernedTurn({
      telemetry,
      system: "s",
      history: [],
      instruction: "list the nodes",
      tools: {
        search_nodes: {
          description: "d",
          inputSchema: z.object({ q: z.string() }),
          execute: async () => ({ a: undefined, at: new Date(0) }),
        } as never,
      },
      engine: client,
      ledger: {
        modelCallStarted: async () => undefined,
        modelCall: async () => undefined,
        toolCallStarted: async () => undefined,
        toolCall: (record) => {
          digests.push(digestJcs(record.output ?? null));
          return Promise.resolve();
        },
        seal: async () => undefined,
      },
    });
    await drain(result);
    expect(await result.finalText).toBe("There are 3 nodes.");
    expect(digests).toEqual([expect.stringMatching(/^sha256:/)]);
  });

  it("cancels the turn when the recorder throws while building a receipt (negative)", async () => {
    const { engine, client } = setup();
    const outcomes: TurnLedgerOutcome[] = [];
    const result = await runGovernedTurn({
      telemetry,
      system: "s",
      history: [],
      instruction: "list the nodes",
      tools: {
        search_nodes: {
          description: "d",
          inputSchema: { type: "object" } as never,
          execute: async () => "ok",
        } as never,
      },
      engine: client,
      ledger: {
        modelCallStarted: async () => undefined,
        modelCall: async () => undefined,
        // Not async: the throw happens before any promise exists.
        toolCallStarted: async () => undefined,
        toolCall: () => {
          throw new TypeError("$.output must be a plain object");
        },
        seal: async (outcome) => {
          outcomes.push(outcome);
        },
      },
    });
    await drain(result);
    expect(
      engine.posts
        .filter((p) => p.route === "tool-result")
        .map((p) => (p.body as { status?: string }).status),
    ).not.toContain("ok");
    expect(outcomes.map((o) => o.status)).toEqual(["aborted"]);
    await expect(result.finalText).rejects.toThrow(
      "$.output must be a plain object",
    );
  });

  it("seals the run as failed when the engine cannot be reached mid-turn", async () => {
    const outcomes: TurnLedgerOutcome[] = [];
    // Ready answers, then every turn route fails: the engine went away.
    let calls = 0;
    const flaky = new StellaEngineClient({
      baseUrl: "http://engine.test",
      token: "fake-token",
      fetchImpl: async (input) => {
        calls += 1;
        if (String(input).endsWith("/readyz"))
          return new Response(JSON.stringify({ state: "ready" }), {
            status: 200,
          });
        throw Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        });
      },
    });
    const result = await runGovernedTurn({
      telemetry,
      system: "s",
      history: [],
      instruction: "hi",
      tools: {},
      engine: flaky,
      ledger: {
        modelCallStarted: async () => undefined,
        modelCall: async () => undefined,
        toolCallStarted: async () => undefined,
        toolCall: async () => undefined,
        seal: async (outcome) => {
          outcomes.push(outcome);
        },
      },
    });
    const parts = await drain(result);
    expect(parts).toEqual([
      { type: "error", error: expect.any(EngineUnavailableError) },
    ]);
    expect(calls).toBeGreaterThan(1);
    expect(outcomes).toEqual([
      { status: "failed", error: expect.stringContaining("unavailable") },
    ]);
  });

  // The engine learns only a classified error when a model call fails, and
  // reports it back as text. Before this the turn's error part was a bare
  // Error, and every surface said "could not be reached" for a revoked key,
  // an unknown model or a provider outage alike.
  describe("a model call that fails ends the turn with the failure's own code", () => {
    const failingScript = (): ServerFrame[] => [
      {
        type: "provider_request",
        request_id: "prov-1-0",
        provider_id: "openrouter",
        role: "worker",
        request: { messages: [{ role: "user", content: "hi" }] },
      } as ServerFrame,
      {
        type: "event",
        event: { type: "error", message: "provider rejected the request" },
      } as ServerFrame,
      {
        type: "turn_complete",
        outcome: {
          status: "aborted",
          reason: "provider error",
          cost_usd: 0,
        },
      } as ServerFrame,
    ];

    async function failWith(err: unknown) {
      streamAgentReply.mockReset();
      streamAgentReply.mockImplementation(() => {
        throw err;
      });
      const { client } = setup(failingScript());
      const result = await runGovernedTurn({
        telemetry,
        system: "s",
        history: [],
        instruction: "hi",
        tools: {},
        engine: client,
      });
      const parts = await drain(result);
      const errors = parts.filter((p) => p.type === "error");
      await expect(result.finalText).resolves.toBeDefined();
      return errors.map((p) => p.error);
    }

    it("names the provider's status", async () => {
      const errors = await failWith(
        Object.assign(new Error("Unauthorized: key sk-or-v1-abc revoked"), {
          statusCode: 401,
        }),
      );
      expect(errors.length).toBeGreaterThan(0);
      for (const error of errors) {
        expect(error).toBeInstanceOf(ModelCallFailedError);
        expect(error).toMatchObject({ code: "model_call_failed", status: 401 });
        // The vendor's body can echo the request; the message names the status.
        expect((error as Error).message).not.toContain("sk-or");
      }
    });

    it("says the call failed before the provider answered when there is no status", async () => {
      const errors = await failWith(new Error("socket hang up"));
      expect(errors.length).toBeGreaterThan(0);
      for (const error of errors) {
        expect(error).toMatchObject({
          code: "model_call_failed",
          status: null,
        });
        expect((error as Error).message).toBe(
          "the model call failed before the provider answered",
        );
      }
    });

    // A cancel is the turn's own doing, not the provider's. A caller that
    // disconnects mid-call must read as engine_aborted (409), not as a model
    // failure (502) that sends an owner to check the model key.
    it("leaves the turn's own cancel alone (negative)", async () => {
      streamAgentReply.mockReset();
      const controller = new AbortController();
      streamAgentReply.mockImplementation(() => {
        controller.abort();
        throw Object.assign(new Error("aborted"), { statusCode: 499 });
      });
      const { client } = setup(failingScript());
      const modelCalls: TurnLedgerModelCall[] = [];
      const result = await runGovernedTurn({
        telemetry,
        system: "s",
        history: [],
        instruction: "hi",
        tools: {},
        abortSignal: controller.signal,
        engine: client,
        ledger: {
          modelCallStarted: async () => undefined,
          modelCall: async (record) => {
            modelCalls.push(record);
          },
          toolCallStarted: async () => undefined,
          toolCall: async () => undefined,
          seal: async () => undefined,
        },
      });
      const parts = await drain(result);
      const errors = parts
        .filter((p) => p.type === "error")
        .map((p) => p.error);
      expect(errors.length).toBeGreaterThan(0);
      for (const error of errors)
        expect(error).not.toBeInstanceOf(ModelCallFailedError);
      // The record says the call was cancelled, not that the provider failed.
      expect(modelCalls.map((c) => c.outcome)).toEqual(["cancelled"]);
    });

    it("keeps a failure that already carries a code", async () => {
      const limit = Object.assign(new Error("daily ceiling"), {
        code: "assistant_model_key_limit",
      });
      const errors = await failWith(limit);
      expect(errors.length).toBeGreaterThan(0);
      for (const error of errors) expect(error).toBe(limit);
    });
  });

  it("declares the whole belt to the engine and shows the model only the pinned tools, the meta-tools and what it loaded", async () => {
    const { engine, client } = setup();
    const governed: Record<string, unknown> = {};
    for (let i = 0; i < 40; i += 1) {
      governed[`tool_${i}`] = {
        description: `Tool number ${i}`,
        inputSchema: { type: "object" } as never,
        execute: async () => i,
      };
    }
    governed.search_nodes = {
      description: "Search graph nodes",
      inputSchema: { type: "object" } as never,
      execute: async () => ({ rows: 3 }),
    };
    const belt = createToolBelt({
      tools: governed as never,
      pinned: ["search_nodes"],
      modelId: "anthropic/claude-sonnet-4.6",
    });
    const result = await runGovernedTurn({
      telemetry,
      model: { modelId: "anthropic/claude-sonnet-4.6" } as never,
      system: "s",
      history: [],
      instruction: "list the nodes",
      tools: belt.tools,
      modelTools: belt.modelTools,
      governance: belt.governance,
      engine: client,
    });
    await drain(result);
    // The engine's gate knows every tool; the provider saw three.
    const request = engine.turnRequests[0] as { tools: unknown[] };
    expect(request.tools).toHaveLength(43);
    const shown = streamAgentReply.mock.calls.map((call) =>
      Object.keys((call[0] as { tools: Record<string, unknown> }).tools).sort(),
    );
    expect(shown[0]).toEqual([LOAD_TOOLS, SEARCH_TOOLS, "search_nodes"].sort());
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

// A person's stop (#4164): `cancel_assistant_turn` aborts the caller's signal
// with a string reason. The seal carries that reason, and a completion the
// engine asks for after the stop is recorded and never sent.
describe("a person's stop (#4164)", () => {
  const PERSON = "stopped by the person who asked";

  beforeEach(() => {
    streamAgentReply.mockReset();
  });

  function recordingLedger() {
    const started: TurnLedgerModelIntent[] = [];
    const modelCalls: TurnLedgerModelCall[] = [];
    const outcomes: TurnLedgerOutcome[] = [];
    const ledger: TurnLedger = {
      modelCallStarted: async (record) => {
        started.push(record);
      },
      modelCall: async (record) => {
        modelCalls.push(record);
      },
      toolCallStarted: async () => undefined,
      toolCall: async () => undefined,
      seal: async (outcome) => {
        outcomes.push(outcome);
      },
    };
    return { ledger, started, modelCalls, outcomes };
  }

  /** A turn whose caller aborts as the engine asks for the first completion. */
  async function abortedAtFirstCompletion(
    abort: (controller: AbortController) => void,
  ) {
    const { client } = setup();
    const controller = new AbortController();
    const log = recordingLedger();
    const result = await runGovernedTurn({
      telemetry,
      system: "s",
      history: [],
      instruction: "hi",
      tools: {},
      // The guard runs as the request arrives, before anything is sent, which
      // is where a stop in flight lands.
      budgetGuard: () => {
        abort(controller);
        return "continue";
      },
      abortSignal: controller.signal,
      engine: client,
      ledger: log.ledger,
    });
    const parts = await drain(result);
    return { log, parts };
  }

  it("records a completion asked for after the stop as cancelled, and never sends it", async () => {
    const { log, parts } = await abortedAtFirstCompletion((c) =>
      c.abort(PERSON),
    );
    expect(streamAgentReply).not.toHaveBeenCalled();
    expect(log.started).toEqual([]);
    expect(log.modelCalls.map((c) => c.outcome)).toEqual(["cancelled"]);
    expect(parts.find((p) => p.type === "error")).toMatchObject({
      error: expect.objectContaining({ code: "engine_aborted" }),
    });
  });

  it("seals the run with the person's reason", async () => {
    const { log } = await abortedAtFirstCompletion((c) => c.abort(PERSON));
    expect(log.outcomes).toEqual([{ status: "aborted", reason: PERSON }]);
  });

  it("keeps the engine's reason for a disconnect, which aborts with no reason (negative)", async () => {
    const { log } = await abortedAtFirstCompletion((c) => c.abort());
    expect(log.outcomes).toEqual([{ status: "aborted", reason: "cancelled" }]);
  });

  it("keeps the engine's reason for a budget stop, which never aborts the caller's signal (negative)", async () => {
    const { client } = setup();
    const log = recordingLedger();
    const result = await runGovernedTurn({
      telemetry,
      system: "s",
      history: [],
      instruction: "hi",
      tools: {},
      budgetGuard: () => "stop",
      abortSignal: new AbortController().signal,
      engine: client,
      ledger: log.ledger,
    });
    await drain(result);
    expect(log.outcomes).toEqual([{ status: "aborted", reason: "cancelled" }]);
  });
});
