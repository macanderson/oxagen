import { describe, it, expect } from "vitest";
import { MemoryWorkspace } from "./workspaces/memory";
import { runCodingAgent } from "./engine";
import type { AgentAi, ModelRunArgs } from "./ports";

/** A fake AgentAi that captures the messages it was called with and returns immediately. */
function capturingAi(capture: { messages: unknown[] }): AgentAi {
  return {
    stream(args: ModelRunArgs) {
      capture.messages = args.messages;
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", text: "ok" };
        })(),
        steps: Promise.resolve([{}]),
        usage: Promise.resolve({
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        }),
        response: Promise.resolve({ messages: [] }),
      } as unknown as ReturnType<AgentAi["stream"]>;
    },
    generateObject: async () => ({
      object: {} as never,
      usage: { totalTokens: 0 },
    }),
  };
}

describe("runCodingAgent — pasted image attachments", () => {
  it("attaches images as multimodal content parts alongside the instruction text", async () => {
    const ws = new MemoryWorkspace({});
    const capture: { messages: unknown[] } = { messages: [] };
    const png = Buffer.from("fake-png-bytes");

    await runCodingAgent({
      workspace: ws,
      ai: capturingAi(capture),
      instruction: "what's wrong in this screenshot?",
      images: [{ data: png, mediaType: "image/png" }],
      model: "anthropic/claude-opus-4-8",
    });

    const instructionMsg = capture.messages.at(-1) as {
      role: string;
      content: unknown;
    };
    expect(instructionMsg.role).toBe("user");
    expect(Array.isArray(instructionMsg.content)).toBe(true);
    const parts = instructionMsg.content as Array<Record<string, unknown>>;
    expect(parts).toEqual([
      { type: "text", text: "what's wrong in this screenshot?" },
      { type: "image", image: png, mediaType: "image/png" },
    ]);
  });

  it("attaches multiple images in order", async () => {
    const ws = new MemoryWorkspace({});
    const capture: { messages: unknown[] } = { messages: [] };
    const a = Buffer.from("a");
    const b = Buffer.from("b");

    await runCodingAgent({
      workspace: ws,
      ai: capturingAi(capture),
      instruction: "compare these two",
      images: [
        { data: a, mediaType: "image/png" },
        { data: b, mediaType: "image/png" },
      ],
      model: "anthropic/claude-opus-4-8",
    });

    const instructionMsg = capture.messages.at(-1) as {
      role: string;
      content: unknown;
    };
    const parts = instructionMsg.content as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(3); // 1 text + 2 images
    expect(parts[1]).toEqual({
      type: "image",
      image: a,
      mediaType: "image/png",
    });
    expect(parts[2]).toEqual({
      type: "image",
      image: b,
      mediaType: "image/png",
    });
  });

  it("keeps the plain-string content shape when there are no images (unchanged from before)", async () => {
    const ws = new MemoryWorkspace({});
    const capture: { messages: unknown[] } = { messages: [] };

    await runCodingAgent({
      workspace: ws,
      ai: capturingAi(capture),
      instruction: "text-only turn",
      model: "anthropic/claude-opus-4-8",
    });

    const instructionMsg = capture.messages.at(-1) as {
      role: string;
      content: unknown;
    };
    expect(instructionMsg.content).toBe("text-only turn");
  });

  it("keeps the plain-string content shape when images is an empty array", async () => {
    const ws = new MemoryWorkspace({});
    const capture: { messages: unknown[] } = { messages: [] };

    await runCodingAgent({
      workspace: ws,
      ai: capturingAi(capture),
      instruction: "text-only turn",
      images: [],
      model: "anthropic/claude-opus-4-8",
    });

    const instructionMsg = capture.messages.at(-1) as {
      role: string;
      content: unknown;
    };
    expect(instructionMsg.content).toBe("text-only turn");
  });
});
