/**
 * The Phase C witness: a full turn — multi-step, tool-calling, metered — driven
 * end to end through the real {@link StellaSidecarClient} against a scripted
 * engine, producing the same `RunCodingAgentResult` shape `runCodingAgent`
 * produces.
 *
 * This is what "Stella runs the turn" means in code, and it fails on `main`
 * because none of the path it exercises existed there.
 */
import { describe, expect, test, vi } from "vitest";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { StellaSidecarClient } from "@oxagen/stella-engine-client";
import type { AgentAi, RunCodingAgentOptions } from "@oxagen/agent-engine";
import { createFakeSidecar, type FakeStep } from "./fake-sidecar";
import {
  buildBudgetSpec,
  runStellaTurn,
  StellaTurnAbortedError,
  stopReasonFor,
  sumUsage,
} from "./run-stella-turn";
import { UnsupportedTurnContentError } from "./message-mapping";

/**
 * A scripted `AgentAi`: replays canned completions, and records what it was
 * asked. Stands in for `streamAgentReply` — the port is the same either way,
 * which is the property that lets the Stella path reuse the host's metering
 * unchanged.
 */
function scriptedAi(
  replies: readonly {
    text?: string;
    toolCalls?: { toolCallId: string; toolName: string; input: unknown }[];
    usage?: { inputTokens: number; outputTokens: number };
  }[],
): AgentAi & { calls: unknown[] } {
  const calls: unknown[] = [];
  let index = 0;
  const ai = {
    calls,
    stream(args: unknown) {
      calls.push(args);
      const reply = replies[index++] ?? {};
      return {
        fullStream: (async function* () {
          if (reply.text) yield { type: "text-delta", text: reply.text };
        })(),
        text: Promise.resolve(reply.text ?? ""),
        toolCalls: Promise.resolve(reply.toolCalls ?? []),
        usage: Promise.resolve(
          reply.usage ?? { inputTokens: 10, outputTokens: 5 },
        ),
        finishReason: Promise.resolve(
          reply.toolCalls?.length ? "tool-calls" : "stop",
        ),
      } as never;
    },
    generateObject: async () => {
      throw new Error("not used on this path");
    },
  };
  return ai as AgentAi & { calls: unknown[] };
}

function leaseFor(script: readonly FakeStep[]) {
  const fake = createFakeSidecar(script);
  const client = new StellaSidecarClient({
    baseUrl: "http://127.0.0.1:1",
    token: "test-token",
    fetchImpl: fake.fetchImpl,
  });
  return { fake, lease: { client, release: vi.fn() } };
}

function baseOptions(over: Partial<RunCodingAgentOptions> = {}) {
  return {
    ai: scriptedAi([{ text: "done" }]),
    instruction: "do the thing",
    system: "be helpful",
    model: "anthropic/claude-fable-5",
    ...over,
  } as RunCodingAgentOptions;
}

describe("runStellaTurn", () => {
  test("drives a two-step tool-using turn and returns the engine's answer", async () => {
    const execute = vi.fn(async () => "18C and clear");
    const tools: ToolSet = {
      get_weather: tool({
        description: "weather",
        inputSchema: z.object({ city: z.string() }),
        execute,
      }),
    };
    const ai = scriptedAi([
      {
        toolCalls: [
          {
            toolCallId: "c1",
            toolName: "get_weather",
            input: { city: "Paris" },
          },
        ],
        usage: { inputTokens: 42, outputTokens: 17 },
      },
      {
        text: "It is 18C in Paris.",
        usage: { inputTokens: 96, outputTokens: 12 },
      },
    ]);
    const events: unknown[] = [];
    const { fake, lease } = leaseFor([
      { kind: "provider_request" },
      {
        kind: "event",
        event: {
          type: "tool_start",
          call: {
            call_id: "c1",
            name: "get_weather",
            input: { city: "Paris" },
          },
        },
      },
      { kind: "tool_request", name: "get_weather", input: { city: "Paris" } },
      {
        kind: "event",
        event: {
          type: "tool_result",
          call_id: "c1",
          output: { ok: { content: "18C and clear" } },
          duration_ms: 12,
        },
      },
      { kind: "provider_request" },
      { kind: "complete", text: "It is 18C in Paris." },
    ]);

    const result = await runStellaTurn(
      baseOptions({ ai, extraTools: tools, onEvent: (e) => events.push(e) }),
      { lease },
    );

    expect(result.text).toBe("It is 18C in Paris.");
    expect(result.steps).toBe(2);
    // The host made both model calls, so the host's own numbers are the total.
    expect(result.usage).toEqual({
      inputTokens: 138,
      outputTokens: 29,
      totalTokens: 167,
    });
    // The host ran the tool exactly once — the engine asked, the host answered.
    expect(execute).toHaveBeenCalledTimes(1);
    const toolPosts = fake.posts.filter((p) => p.route === "tool-result");
    expect(toolPosts).toHaveLength(1);
    expect(toolPosts[0]!.body).toMatchObject({
      output: { ok: { content: "18C and clear" } },
    });
    // Both model calls were answered on the ok arm, carrying the host's usage.
    const providerPosts = fake.posts.filter(
      (p) => p.route === "provider-result",
    );
    expect(providerPosts).toHaveLength(2);
    expect(providerPosts.every((p) => p.body.status === "ok")).toBe(true);
    // Engine events reached the host's CodingEvent stream.
    expect(events).toContainEqual({
      type: "tool-call",
      name: "get_weather",
      input: { city: "Paris" },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool-result",
        name: "get_weather",
        ok: true,
      }),
    );
  });

  test("advertises tools with read_only derived from the mutating list", async () => {
    const { fake, lease } = leaseFor([{ kind: "complete", text: "" }]);
    await runStellaTurn(
      baseOptions({
        extraTools: {
          look: tool({
            description: "",
            inputSchema: z.object({}),
            execute: async () => "",
          }),
          deploy: tool({
            description: "",
            inputSchema: z.object({}),
            execute: async () => "",
          }),
        },
        mutatingToolNames: ["deploy"],
      }),
      { lease },
    );
    const advertised = fake.turnRequest!.tools as {
      name: string;
      read_only: boolean;
    }[];
    expect(advertised).toEqual(
      expect.arrayContaining([
        {
          name: "look",
          description: "",
          input_schema: expect.anything(),
          read_only: true,
        },
        {
          name: "deploy",
          description: "",
          input_schema: expect.anything(),
          read_only: false,
        },
      ]),
    );
  });

  test("recalls memory once up front, never as a mid-turn callback", async () => {
    // This is the change #1236 and #1246 are waiting on: the recalled text is
    // in the opening transcript, and `recallContext` is called exactly once.
    const recallContext = vi.fn(async () => "you learned X last time");
    const { fake, lease } = leaseFor([
      { kind: "provider_request" },
      { kind: "complete", text: "ok" },
    ]);
    await runStellaTurn(
      baseOptions({ memory: { recallContext, remember: () => undefined } }),
      { lease },
    );
    expect(recallContext).toHaveBeenCalledTimes(1);
    const messages = fake.turnRequest!.messages as {
      role: string;
      content?: string;
    }[];
    // System first, then the recalled memory as a volatile USER message, then
    // the instruction — the same placement the TS loop uses to keep the cached
    // system prefix warm.
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "user"]);
    expect(messages[1]!.content).toBe("you learned X last time");
    expect(messages[2]!.content).toBe("do the thing");
  });

  test("a recall failure degrades the turn instead of killing it", async () => {
    const onError = vi.fn();
    const { lease } = leaseFor([{ kind: "complete", text: "ok" }]);
    const result = await runStellaTurn(
      baseOptions({
        onError,
        memory: {
          recallContext: async () => {
            throw new Error("memory store down");
          },
          remember: () => undefined,
        },
      }),
      { lease },
    );
    expect(result.text).toBe("ok");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "memory-recall" }),
    );
  });

  test("forwards raw frames to onStreamPart even when they have no CodingEvent", async () => {
    const parts: unknown[] = [];
    const { lease } = leaseFor([
      { kind: "event", event: { type: "step_usage", step: 1 } },
      { kind: "complete", text: "ok" },
    ]);
    await runStellaTurn(baseOptions({ onStreamPart: (p) => parts.push(p) }), {
      lease,
    });
    // Mapping is the lossy projection; the raw tap is the record.
    expect(parts).toContainEqual({ type: "step_usage", step: 1 });
  });

  test("computes the diff from the workspace, as the TS loop does", async () => {
    const { lease } = leaseFor([{ kind: "complete", text: "edited" }]);
    const events: unknown[] = [];
    const workspace = {
      root: "/w",
      diff: async () => "--- a/x.ts\n+++ b/x.ts\n",
      readFile: async () => "",
      writeFile: async () => undefined,
      editFile: async () => 1,
      list: async () => [],
      glob: async () => [],
      grep: async () => [],
      exec: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
      }),
    };
    const result = await runStellaTurn(
      baseOptions({
        workspace: workspace as never,
        speculativeTools: false,
        onEvent: (e) => events.push(e),
      }),
      { lease },
    );
    expect(result.changedFiles).toEqual(["x.ts"]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "final-diff", changedFiles: ["x.ts"] }),
    );
  });

  test("a budget abort is a stop reason, not a thrown error", async () => {
    const { lease } = leaseFor([
      { kind: "abort", reason: "turn budget exhausted", costUsd: 1.5 },
    ]);
    const result = await runStellaTurn(baseOptions(), { lease });
    expect(result.stopReason).toBe("budget");
    expect(result.text).toBe("");
  });

  test("an abort the host cannot name throws instead of looking like success", async () => {
    // An empty-text "completed" turn is the shape of failure that reads as
    // success in every downstream row.
    const { lease } = leaseFor([
      { kind: "abort", reason: "provider returned 500 twice" },
    ]);
    await expect(runStellaTurn(baseOptions(), { lease })).rejects.toThrow(
      StellaTurnAbortedError,
    );
  });

  test("refuses a turn carrying attachments it would silently drop", async () => {
    const { lease } = leaseFor([{ kind: "complete", text: "" }]);
    await expect(
      runStellaTurn(
        baseOptions({
          images: [{ data: Buffer.from("x"), mediaType: "image/png" }],
        }),
        { lease },
      ),
    ).rejects.toThrow(UnsupportedTurnContentError);
  });

  test("the model never receives an executable tool set", async () => {
    // Otherwise the SDK runs the call and the engine asks the host to run it
    // too: one side effect becoming two.
    const ai = scriptedAi([{ text: "ok" }]);
    const { lease } = leaseFor([
      { kind: "provider_request" },
      { kind: "complete", text: "ok" },
    ]);
    await runStellaTurn(
      baseOptions({
        ai,
        extraTools: {
          bash: tool({
            description: "",
            inputSchema: z.object({}),
            execute: async () => "",
          }),
        },
      }),
      { lease },
    );
    const args = ai.calls[0] as { tools: ToolSet };
    expect(args.tools.bash).not.toHaveProperty("execute");
  });
});

describe("buildBudgetSpec", () => {
  test("arms nothing when the host cannot price a call", () => {
    // A ceiling that can never be reached reads as protection and is not.
    expect(buildBudgetSpec(false)).toEqual({ mode: "off" });
  });

  test("observes, rather than enforces, once pricing exists", () => {
    expect(buildBudgetSpec(true)).toEqual({ mode: "observed" });
  });
});

describe("stopReasonFor", () => {
  test("names the orderly stops", () => {
    expect(stopReasonFor("turn budget exhausted")).toBe("budget");
    expect(stopReasonFor("reached max steps")).toBe("max-steps");
    expect(stopReasonFor("step limit reached")).toBe("max-steps");
  });

  test("leaves a real failure unnamed so the caller throws", () => {
    expect(stopReasonFor("provider auth rejected")).toBeUndefined();
    expect(stopReasonFor("")).toBeUndefined();
  });
});

describe("sumUsage", () => {
  test("totals input, output and the derived total", () => {
    expect(
      sumUsage([
        { reported: true, input_tokens: 10, output_tokens: 2 },
        { reported: true, input_tokens: 5, output_tokens: 3 },
      ]),
    ).toEqual({ inputTokens: 15, outputTokens: 5, totalTokens: 20 });
  });

  test("omits cached tokens entirely when no call reported any", () => {
    // Absent means "not reported"; zero would claim a measured cache miss.
    expect(
      sumUsage([{ reported: true, input_tokens: 1, output_tokens: 1 }]),
    ).not.toHaveProperty("cachedInputTokens");
  });

  test("sums cached tokens when a call reported them", () => {
    expect(
      sumUsage([
        {
          reported: true,
          input_tokens: 10,
          output_tokens: 1,
          cached_input_tokens: 8,
        },
      ]),
    ).toMatchObject({ cachedInputTokens: 8 });
  });
});
