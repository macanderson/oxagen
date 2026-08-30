/**
 * Tests for the coordinator resolution seam — the single place a role is
 * resolved through the runtime `buildProvider` factory into an engine `AgentAi`.
 *
 * Proves the role-resolution path selects the right transport for on-device vs
 * cloud ids, that the cloud branch keeps the caller's native metered port (and
 * resolves the concrete slug), and that `meteredCloudGenerate` routes a cloud
 * completion through the SAME metered path (`createMeteredAi`) — metrics emit.
 */
import { describe, it, expect, vi } from "vitest";
import type { AgentAi } from "@oxagen/agent-engine";
import { resolveCoordinatorAi, meteredCloudGenerate } from "../coordinator.js";
import { createMeteredAi } from "../../metered-ai.js";
import type { ModelProvider } from "../../../runtime/types.js";

// A metered/gateway port stand-in: stream() resolves text + usage; generateObject
// is unused here. `usage` settling is what drives createMeteredAi's metrics emit.
function fakeBaseAi(
  over: { text?: string; inputTokens?: number; outputTokens?: number } = {},
): {
  ai: AgentAi;
  stream: ReturnType<typeof vi.fn>;
} {
  const text = over.text ?? "cloud answer";
  const usage = {
    inputTokens: over.inputTokens ?? 11,
    outputTokens: over.outputTokens ?? 7,
    totalTokens: (over.inputTokens ?? 11) + (over.outputTokens ?? 7),
  };
  const stream = vi.fn(() => ({
    text: Promise.resolve(text),
    usage: Promise.resolve(usage),
    // A minimal async iterable so any textStream consumer still works.
    textStream: (async function* () {
      yield text;
    })(),
  }));
  const ai = {
    stream,
    generateObject: vi.fn(async () => ({ object: {} as never, usage: {} })),
  } as unknown as AgentAi;
  return { ai, stream };
}

/** A fake on-device ModelProvider — only the methods the adapter touches. */
function fakeOnDeviceProvider(): ModelProvider {
  return {
    id: () => "fake-local-30b",
    kind: () => "on-device",
    isAvailable: async () => true,
    ensureReady: async () => {},
    complete: async () => ({
      text: "local",
      usage: { inputTokens: 1, outputTokens: 1 },
      model: "fake-local-30b",
      kind: "on-device" as const,
      costUsd: 0,
    }),
    estimateCost: () => ({ tokens: 2, usd: 0 }),
    capabilities: () => ({
      id: "fake-local-30b",
      kind: "on-device",
      vendor: "on-device",
      contextWindow: 32768,
      offline: true,
      tools: true,
    }),
    // dispose is OnDeviceProvider-only; the adapter calls it through the cast.
    dispose: async () => {},
  } as unknown as ModelProvider;
}

describe("resolveCoordinatorAi", () => {
  it("cloud id → keeps the caller's native metered port and resolves the concrete slug", async () => {
    const { ai } = fakeBaseAi();
    const resolved = await resolveCoordinatorAi({
      baseAi: ai,
      coordinatorId: "haiku",
    });
    expect(resolved.kind).toBe("cloud");
    // The engine keeps streaming through the caller's metered port (native tools).
    expect(resolved.ai).toBe(ai);
    // The provider resolved a concrete gateway slug (vendor/model), not a registry id.
    expect(resolved.modelId).toContain("/");
    expect(resolved.dispose).toBeUndefined();
  });

  it("on-device id → swaps the port for the GGUF adapter and reports on-device", async () => {
    const { ai } = fakeBaseAi();
    const provider = fakeOnDeviceProvider();
    const resolved = await resolveCoordinatorAi({
      baseAi: ai,
      coordinatorId: "on-device",
      buildProviderImpl: () => provider,
    });
    expect(resolved.kind).toBe("on-device");
    expect(resolved.modelId).toBe("fake-local-30b");
    // The port is the on-device adapter, NOT the cloud base port.
    expect(resolved.ai).not.toBe(ai);
    expect(typeof resolved.ai.stream).toBe("function");
    expect(typeof resolved.dispose).toBe("function");
    await resolved.dispose?.();
  });

  it("cloud credentialPreflight rejects when no credential resolves", async () => {
    const { ai } = fakeBaseAi();
    // A cloud provider whose ensureReady throws (no key) — the preflight surfaces it.
    const provider: ModelProvider = {
      id: () => "haiku",
      kind: () => "cloud",
      isAvailable: async () => false,
      ensureReady: async () => {
        throw new Error("No AI credential for haiku");
      },
      complete: async () => {
        throw new Error("unreachable");
      },
      estimateCost: () => ({ tokens: 1, usd: 0 }),
      capabilities: () => ({
        id: "haiku",
        kind: "cloud",
        vendor: "anthropic",
        contextWindow: 200000,
        offline: false,
        tools: true,
      }),
    };
    await expect(
      resolveCoordinatorAi({
        baseAi: ai,
        coordinatorId: "haiku",
        credentialPreflight: true,
        buildProviderImpl: () => provider,
      }),
    ).rejects.toThrow(/No AI credential/);
  });
});

describe("meteredCloudGenerate", () => {
  it("routes a cloud completion through the base port (system split out, text + usage returned)", async () => {
    const { ai, stream } = fakeBaseAi({
      text: "hi",
      inputTokens: 3,
      outputTokens: 5,
    });
    const generate = meteredCloudGenerate(ai);
    const out = await generate({
      model: "anthropic/claude-haiku-4.5",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hello" },
      ],
    });
    expect(out).toEqual({
      text: "hi",
      usage: { inputTokens: 3, outputTokens: 5 },
    });
    // system-role message is lifted into `system`, not left in `messages`.
    const call = stream.mock.calls[0]?.[0] as {
      system: string;
      messages: unknown[];
      tools: unknown;
    };
    expect(call.system).toBe("be brief");
    expect(call.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(call.tools).toEqual({});
  });

  it("is metered: wrapping the base in createMeteredAi emits a metrics event on completion", async () => {
    const { ai } = fakeBaseAi({ text: "ok", inputTokens: 9, outputTokens: 4 });
    const onMetrics = vi.fn();
    const metered = createMeteredAi(ai, { onMetrics });
    const generate = meteredCloudGenerate(metered);
    await generate({
      model: "anthropic/claude-haiku-4.5",
      messages: [{ role: "user", content: "hello" }],
    });
    // The stream's usage settles → the metered port prices + emits the event.
    await Promise.resolve();
    await Promise.resolve();
    expect(onMetrics).toHaveBeenCalled();
    const ev = onMetrics.mock.calls[0]?.[0] as { model: string };
    expect(ev.model).toBe("anthropic/claude-haiku-4.5");
  });
});
