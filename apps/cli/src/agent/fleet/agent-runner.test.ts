/**
 * agent-runner.test.ts — pins the fleet runner port's contract. The module is
 * a deliberate leaf (extracted from orchestrator.ts to break a 2-file import
 * cycle), so it must stay type-only: ZERO runtime exports at load time. The
 * `AgentRunner` shape itself is compile-checked by implementing it below —
 * a minimal call needs only `prompt` and `cwd` (everything else optional,
 * which is what lets the orchestrator inject memory/fileLock per task), and
 * the result carries text/steps/usage. Vitest strips types without checking,
 * so the shape half binds when the workspace typechecker runs; the runtime
 * half here is the leaf/no-runtime-exports guarantee.
 */
import { describe, expect, it } from "vitest";
import type { AgentRunner } from "./agent-runner.js";

describe("fleet agent-runner port", () => {
  it("is a leaf with no runtime bindings — the orchestrator can type-depend on it without a cycle", async () => {
    const port = await import("./agent-runner.js");
    expect(Object.keys(port)).toEqual([]);
  });

  it("a minimal implementation satisfies the port: prompt+cwd in, text/steps/usage out", async () => {
    const seen: { prompt: string; cwd: string }[] = [];
    const runner: AgentRunner = async (opts) => {
      seen.push({ prompt: opts.prompt, cwd: opts.cwd });
      opts.onText?.("hello");
      opts.onToolCall?.("bash", { command: "ls" });
      return {
        text: `did: ${opts.prompt}`,
        steps: 2,
        usage: { inputTokens: 10, outputTokens: 4 },
      };
    };

    const textDeltas: string[] = [];
    const toolCalls: [string, unknown][] = [];
    const result = await runner({
      prompt: "fix the flaky test",
      cwd: "/work/tree",
      readOnly: true,
      memory: null,
      fileLock: null,
      onText: (delta) => void textDeltas.push(delta),
      onToolCall: (name, input) => void toolCalls.push([name, input]),
    });

    expect(seen).toEqual([{ prompt: "fix the flaky test", cwd: "/work/tree" }]);
    expect(textDeltas).toEqual(["hello"]);
    expect(toolCalls).toEqual([["bash", { command: "ls" }]]);
    expect(result).toEqual({
      text: "did: fix the flaky test",
      steps: 2,
      usage: { inputTokens: 10, outputTokens: 4 },
    });
  });

  it("supports abort delivery through the optional signal, as the orchestrator drains tasks", async () => {
    const runner: AgentRunner = async (opts) => {
      if (opts.signal?.aborted) throw new Error("aborted before start");
      return { text: "", steps: 0, usage: {} };
    };
    const controller = new AbortController();
    controller.abort();
    await expect(
      runner({ prompt: "p", cwd: "/w", signal: controller.signal }),
    ).rejects.toThrow("aborted before start");
  });
});
