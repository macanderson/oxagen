/**
 * Tests for the on-device `LanguageModelV3` shim — the bridge that lets a
 * single-shot GGUF completion model drive the AI SDK's tool-calling loop.
 *
 * The runtime is mocked with a plain `complete` fn so these run with no weights,
 * no native dep, and no network — pinning the prompt-rendering and tool-call
 * parsing contract the shim depends on.
 */
import { describe, it, expect } from "vitest";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import {
  createOnDeviceLanguageModel,
  flattenPrompt,
  parseModelText,
  renderToolInstructions,
  type OnDeviceComplete,
} from "../on-device-language-model.js";

const TOOLS: LanguageModelV3CallOptions["tools"] = [
  {
    type: "function",
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
];

/** A `complete` that always returns the given text (with trivial usage). */
function fixedComplete(text: string): OnDeviceComplete {
  return async () => ({ text, usage: { inputTokens: 3, outputTokens: 5 } });
}

async function drain(
  stream: ReadableStream<LanguageModelV3StreamPart>,
): Promise<LanguageModelV3StreamPart[]> {
  const parts: LanguageModelV3StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return parts;
}

describe("renderToolInstructions", () => {
  it("returns empty when no tools are exposed", () => {
    expect(renderToolInstructions(undefined)).toBe("");
    expect(renderToolInstructions([])).toBe("");
  });

  it("lists each tool with its schema and pins the reply convention", () => {
    const out = renderToolInstructions(TOOLS);
    expect(out).toContain("read_file");
    expect(out).toContain("Read a file");
    expect(out).toContain('"path"');
    expect(out).toContain("tool_call");
  });
});

describe("parseModelText", () => {
  it("treats plain prose as a final answer (no tool calls)", () => {
    const r = parseModelText("All done — nothing else to do.");
    expect(r.toolCalls).toEqual([]);
    expect(r.text).toBe("All done — nothing else to do.");
  });

  it("parses a fenced ```json tool_call block", () => {
    const raw =
      '```json\n{ "tool_call": { "name": "read_file", "arguments": { "path": "a.ts" } } }\n```';
    const r = parseModelText(raw);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]?.name).toBe("read_file");
    expect(JSON.parse(r.toolCalls[0]!.input)).toEqual({ path: "a.ts" });
    expect(r.text).toBe("");
  });

  it("parses a bare top-level JSON object with name+arguments", () => {
    const r = parseModelText(
      '{ "name": "read_file", "arguments": { "path": "b.ts" } }',
    );
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]?.name).toBe("read_file");
  });

  it("keeps leading prose while still extracting a fenced call", () => {
    const raw =
      'Let me look at that.\n```json\n{ "tool_call": { "name": "read_file", "arguments": {} } }\n```';
    const r = parseModelText(raw);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.text).toBe("Let me look at that.");
  });
});

describe("flattenPrompt", () => {
  it("flattens system/user/assistant/tool messages into flat completion messages", () => {
    const flat = flattenPrompt([
      { role: "system", content: "You are helpful." },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling a tool" },
          {
            type: "tool-call",
            toolCallId: "1",
            toolName: "read_file",
            input: { path: "a" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "1",
            toolName: "read_file",
            output: { type: "text", value: "file contents" },
          },
        ],
      },
    ]);

    expect(flat[0]).toEqual({ role: "system", content: "You are helpful." });
    expect(flat[1]).toEqual({ role: "user", content: "hi" });
    expect(flat[2]?.role).toBe("assistant");
    expect(flat[2]?.content).toContain("read_file");
    // Tool output comes back to the model as an observation.
    expect(flat[3]?.role).toBe("user");
    expect(flat[3]?.content).toContain("file contents");
  });
});

describe("createOnDeviceLanguageModel — doGenerate", () => {
  const baseOptions = (
    over: Partial<LanguageModelV3CallOptions> = {},
  ): LanguageModelV3CallOptions => ({
    prompt: [{ role: "user", content: [{ type: "text", text: "do it" }] }],
    ...over,
  });

  it("returns text content + a stop finish for a prose reply", async () => {
    const model = createOnDeviceLanguageModel({
      modelId: "test-model",
      complete: fixedComplete("here is the answer"),
    });
    const res = await model.doGenerate(baseOptions());
    expect(res.finishReason.unified).toBe("stop");
    expect(res.content).toEqual([{ type: "text", text: "here is the answer" }]);
    expect(res.usage.inputTokens.total).toBe(3);
    expect(res.usage.outputTokens.total).toBe(5);
  });

  it("returns a tool-call + tool-calls finish when the model emits a call", async () => {
    const model = createOnDeviceLanguageModel({
      modelId: "test-model",
      generateId: () => "call-1",
      complete: fixedComplete(
        '```json\n{ "tool_call": { "name": "read_file", "arguments": { "path": "a.ts" } } }\n```',
      ),
    });
    const res = await model.doGenerate(baseOptions({ tools: TOOLS }));
    expect(res.finishReason.unified).toBe("tool-calls");
    expect(res.content).toEqual([
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "read_file",
        input: '{"path":"a.ts"}',
      },
    ]);
  });

  it("never parses tool calls when a JSON response format is requested", async () => {
    const model = createOnDeviceLanguageModel({
      modelId: "test-model",
      complete: fixedComplete('{ "name": "read_file", "arguments": {} }'),
    });
    const res = await model.doGenerate(
      baseOptions({ responseFormat: { type: "json" } }),
    );
    expect(res.finishReason.unified).toBe("stop");
    expect(res.content).toEqual([
      { type: "text", text: '{ "name": "read_file", "arguments": {} }' },
    ]);
  });
});

describe("createOnDeviceLanguageModel — doStream", () => {
  it("replays a text completion as spec-correct stream parts", async () => {
    const model = createOnDeviceLanguageModel({
      modelId: "test-model",
      generateId: () => "text-1",
      complete: fixedComplete("streamed answer"),
    });
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    });
    const parts = await drain(stream);
    const types = parts.map((p) => p.type);
    expect(types[0]).toBe("stream-start");
    expect(types).toContain("text-start");
    expect(types).toContain("text-delta");
    expect(types).toContain("text-end");
    expect(types.at(-1)).toBe("finish");
    const delta = parts.find((p) => p.type === "text-delta");
    expect(delta && "delta" in delta ? delta.delta : "").toBe(
      "streamed answer",
    );
  });

  it("replays a tool call as tool-input + tool-call parts", async () => {
    const model = createOnDeviceLanguageModel({
      modelId: "test-model",
      generateId: () => "call-9",
      complete: fixedComplete(
        '```json\n{ "tool_call": { "name": "read_file", "arguments": { "path": "z" } } }\n```',
      ),
    });
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      tools: TOOLS,
    });
    const parts = await drain(stream);
    const types = parts.map((p) => p.type);
    expect(types).toContain("tool-input-start");
    expect(types).toContain("tool-input-end");
    expect(types).toContain("tool-call");
    const finish = parts.at(-1);
    expect(finish?.type).toBe("finish");
    expect(
      finish && "finishReason" in finish ? finish.finishReason.unified : "",
    ).toBe("tool-calls");
  });
});
