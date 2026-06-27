/**
 * Regression guard for a silent permission-gate bypass in runAgent.
 *
 * The loop builds a permission-gated, hook-wrapped tool set
 * (`wrapToolsWithGate(buildTools(…, { broker }))`) and must hand THAT set to
 * `streamText`. A merge once left `streamText` calling `buildTools` a second
 * time — raw and ungated — so settings.permissions and Pre/PostToolUse hooks
 * were silently skipped on every CLI agent turn. These tests pin the wiring:
 *   1. `buildTools` is called exactly once, and with the broker threaded in.
 *   2. the tools `streamText` receives are the gated ones (a denied tool's
 *      execute returns the gate's deny string and never runs the real tool).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolSet } from "ai";

// Hoisted so the vi.mock factories (themselves hoisted above imports) can close
// over initialised values instead of TDZ-dead consts.
const h = vi.hoisted(() => {
  const realExecute = vi.fn(async () => "WROTE FILE");
  return {
    streamTextMock: vi.fn(),
    realExecute,
    buildToolsMock: vi.fn(
      (_cwd: string, _opts?: { readOnly?: boolean; broker?: unknown }) => ({
        write: {
          description: "write a file",
          inputSchema: { jsonSchema: { type: "object" } },
          execute: realExecute,
        },
      }),
    ),
  };
});

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: (args: unknown) => h.streamTextMock(args) };
});
vi.mock("../tools.js", () => ({ buildTools: h.buildToolsMock }));

// Keep the loop off the network / filesystem; leave the gate (real) intact.
vi.mock("../env.js", () => ({
  ensureGatewayKey: () => true,
  MissingGatewayKeyError: class extends Error {},
}));
vi.mock("../model.js", () => ({ resolveModelId: () => "test/model" }));
vi.mock("../system-prompt.js", () => ({ buildSystemPrompt: () => "system" }));
vi.mock("../../settings/hooks.js", () => ({
  runHooks: vi.fn(async () => ({ blocked: false, output: "", reason: undefined })),
}));

import { runAgent } from "../loop.js";

function fakeStream() {
  return {
    textStream: (async function* () {
      yield "ok";
    })(),
    steps: Promise.resolve([]),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    response: Promise.resolve({ messages: [] }),
  };
}

describe("runAgent — tools reach streamText fully gated", () => {
  beforeEach(() => {
    h.streamTextMock.mockReset();
    h.streamTextMock.mockImplementation(() => fakeStream());
    h.buildToolsMock.mockClear();
    h.realExecute.mockClear();
  });

  it("builds tools exactly once and threads the permission broker", async () => {
    const broker = { id: "test-broker" } as never;
    await runAgent({
      prompt: "do it",
      broker,
      memory: null,
      settings: { permissions: {}, hooks: {} } as never,
    });

    expect(h.buildToolsMock).toHaveBeenCalledTimes(1);
    expect(h.buildToolsMock.mock.calls[0]?.[1]).toMatchObject({ broker });
  });

  it("hands streamText the gated tool set — a denied tool never runs", async () => {
    await runAgent({
      prompt: "write a file",
      memory: null,
      // Deny the write tool via settings permissions; the real gate enforces it.
      settings: { permissions: { deny: ["write"] }, hooks: {} } as never,
    });

    expect(h.streamTextMock).toHaveBeenCalledTimes(1);
    const passed = h.streamTextMock.mock.calls[0]?.[0] as { tools: ToolSet };
    const gatedWrite = passed.tools.write;
    if (!gatedWrite) throw new Error("expected a gated `write` tool on streamText");

    // Invoke the gated execute: it must short-circuit with a deny string and
    // must NOT reach the underlying tool implementation.
    const out = await gatedWrite.execute?.({} as never, {} as never);
    expect(String(out)).toContain("Permission denied");
    expect(h.realExecute).not.toHaveBeenCalled();
  });
});
