/**
 * Tests for the on-device `AgentAi` adapter — the "local" side of the REPL's
 * `/coordinator remote|local` toggle. A fake `OnDeviceProvider` stands in for the
 * real GGUF runtime so the adapter's contract (prepare → stream → generateObject
 * → dispose) is verified without weights or the optional native dependency.
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { prepareOnDeviceCoordinator } from "../on-device-agent-ai.js";
import type { OnDeviceProvider } from "../../../runtime/providers/on-device.js";

/** A minimal fake standing in for OnDeviceProvider — only the methods we call. */
function fakeProvider(overrides: { completeText?: string } = {}): {
  provider: OnDeviceProvider;
  ensureReady: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
} {
  const ensureReady = vi.fn(async () => {});
  const complete = vi.fn(async () => ({
    text: overrides.completeText ?? "done",
    usage: { inputTokens: 2, outputTokens: 4 },
    model: "fake-local",
    kind: "on-device" as const,
    costUsd: 0,
  }));
  const dispose = vi.fn(async () => {});
  const provider = {
    ensureReady,
    complete,
    dispose,
    id: () => "fake-local",
  } as unknown as OnDeviceProvider;
  return { provider, ensureReady, complete, dispose };
}

describe("prepareOnDeviceCoordinator", () => {
  it("ensures the runtime is ready before returning an AgentAi", async () => {
    const { provider, ensureReady } = fakeProvider();
    const coord = await prepareOnDeviceCoordinator({ provider });
    expect(ensureReady).toHaveBeenCalledOnce();
    expect(coord.modelId).toBe("fake-local");
    expect(typeof coord.ai.stream).toBe("function");
    expect(typeof coord.ai.generateObject).toBe("function");
  });

  it("streams a text turn through the local model", async () => {
    const { provider } = fakeProvider({ completeText: "the local answer" });
    const coord = await prepareOnDeviceCoordinator({ provider });
    const result = coord.ai.stream({
      model: "ignored",
      system: "be brief",
      messages: [{ role: "user", content: "hi" }],
      tools: {},
      stopWhen: (() => true) as never,
    });
    let text = "";
    for await (const chunk of result.textStream) text += chunk;
    expect(text).toBe("the local answer");
  });

  it("generates a structured object through the local model", async () => {
    const { provider, complete } = fakeProvider({
      completeText: '{"answer":"42"}',
    });
    const coord = await prepareOnDeviceCoordinator({ provider });
    const res = await coord.ai.generateObject({
      model: "ignored",
      prompt: "give me the answer",
      schema: z.object({ answer: z.string() }),
    });
    expect(res.object).toEqual({ answer: "42" });
    expect(complete).toHaveBeenCalled();
  });

  it("propagates the runtime's typed errors (never falls back silently)", async () => {
    const { provider, ensureReady } = fakeProvider();
    ensureReady.mockRejectedValueOnce(
      new Error("on-device runtime is not installed"),
    );
    await expect(prepareOnDeviceCoordinator({ provider })).rejects.toThrow(
      /not installed/,
    );
  });

  it("disposes the provider when the coordinator is torn down", async () => {
    const { provider, dispose } = fakeProvider();
    const coord = await prepareOnDeviceCoordinator({ provider });
    await coord.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
