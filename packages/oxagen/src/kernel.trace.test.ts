import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CapabilityContext } from "./types";
import { clearRegistryForTests, registerCapability } from "./registry";
import {
  clearHandlersForTests,
  clearKernelTraceSink,
  clearSecurityEventEmitter,
  invoke,
  registerHandler,
  setKernelTraceSink,
  type KernelTraceEvent,
} from "./kernel";

const ctx: CapabilityContext = {
  orgId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  userId: "u",
  apiKeyId: null,
  requestId: "req_trace",
  surface: "api",
  messageId: "msg_1",
};

const echoCap = () =>
  registerCapability({
    name: "test.trace.echo",
    domain: "test",
    description: "echo",
    mode: "sync" as const,
    surfaces: ["api", "mcp", "agent"] as const,
    layers: ["unit"] as const,
    sensitivity: "low" as const,
    defaultEffect: "allow" as const,
    defaultRoles: { org: {}, workspace: {} },
    input: z.object({ value: z.string() }),
    output: z.object({ value: z.string() }),
  });

describe("kernel trace sink", () => {
  afterEach(() => {
    clearRegistryForTests();
    clearHandlersForTests();
    clearSecurityEventEmitter();
    clearKernelTraceSink();
  });

  it("emits an ok trace with input, output, ids and duration on success", async () => {
    echoCap();
    registerHandler("test.trace.echo", async () => async (input) => input);
    const events: KernelTraceEvent[] = [];
    setKernelTraceSink((e) => events.push(e));

    await invoke("test.trace.echo", { value: "hi" }, ctx, { surface: "agent" });

    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e).toMatchObject({
      capability: "test.trace.echo",
      status: "ok",
      surface: "agent", // opts.surface wins over ctx.surface
      requestId: "req_trace",
      messageId: "msg_1",
      input: { value: "hi" },
      output: { value: "hi" },
    });
    expect(typeof e.durationMs).toBe("number");
    expect(e.durationMs).toBeGreaterThanOrEqual(0);
    expect(e.errorCode).toBeUndefined();
  });

  it("emits an error trace when the handler throws", async () => {
    echoCap();
    registerHandler("test.trace.echo", async () => async () => {
      throw new Error("boom");
    });
    const events: KernelTraceEvent[] = [];
    setKernelTraceSink((e) => events.push(e));

    await expect(
      invoke("test.trace.echo", { value: "x" }, ctx),
    ).rejects.toThrow("boom");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "error", input: { value: "x" } });
    expect(events[0]?.output).toBeUndefined();
  });

  it("emits an invalid_input error trace carrying the raw input", async () => {
    echoCap();
    registerHandler("test.trace.echo", async () => async (input) => input);
    const events: KernelTraceEvent[] = [];
    setKernelTraceSink((e) => events.push(e));

    await expect(
      invoke("test.trace.echo", { value: 42 }, ctx),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: "error",
      errorCode: "invalid_input",
      input: { value: 42 },
    });
  });

  it("emits an invalid_output error trace carrying the bad output", async () => {
    echoCap();
    registerHandler("test.trace.echo", async () => async () => ({
      wrong: true,
    }));
    const events: KernelTraceEvent[] = [];
    setKernelTraceSink((e) => events.push(e));

    await expect(
      invoke("test.trace.echo", { value: "x" }, ctx),
    ).rejects.toMatchObject({
      code: "invalid_output",
    });
    expect(events[0]).toMatchObject({
      status: "error",
      errorCode: "invalid_output",
      output: { wrong: true },
    });
  });

  it("never lets a throwing sink crash the invocation", async () => {
    echoCap();
    registerHandler("test.trace.echo", async () => async (input) => input);
    setKernelTraceSink(() => {
      throw new Error("sink exploded");
    });
    await expect(
      invoke("test.trace.echo", { value: "ok" }, ctx),
    ).resolves.toEqual({
      value: "ok",
    });
  });

  it("does nothing (no crash) when no sink is registered", async () => {
    echoCap();
    registerHandler("test.trace.echo", async () => async (input) => input);
    await expect(
      invoke("test.trace.echo", { value: "ok" }, ctx),
    ).resolves.toEqual({
      value: "ok",
    });
  });

  it("cleared sink stops receiving events", async () => {
    echoCap();
    registerHandler("test.trace.echo", async () => async (input) => input);
    const sink = vi.fn();
    setKernelTraceSink(sink);
    clearKernelTraceSink();
    await invoke("test.trace.echo", { value: "ok" }, ctx);
    expect(sink).not.toHaveBeenCalled();
  });
});
