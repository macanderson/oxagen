/**
 * Pipeline (runTurn) — file-change callback and model-accounting tests.
 *
 * Proves that:
 *  1. runTurn forwards the git diff + changed files to onFileChange after an edit.
 *  2. runTurn fires onFileEdit per landed edit, carrying the edit-integrity
 *     anchor chain.
 */
import { describe, it, expect } from "vitest";
import { MemoryWorkspace } from "../workspaces/memory";
import { runTurn } from "./index";
import { DEFAULT_AGENT_MODEL } from "../engine";
import { classifyTier, modelForTier } from "../router/model-router";
import type { AgentAi, ModelRunArgs } from "../ports";

// ── Minimal AgentAi that optionally edits a file, then returns. ──────────────

function makeAi(editFile?: string): AgentAi {
  return {
    stream(args: ModelRunArgs) {
      return {
        fullStream: (async function* () {
          if (editFile) {
            const editTool = args.tools.edit_file as {
              execute: (i: unknown, o: unknown) => Promise<unknown>;
            };
            await editTool.execute(
              { path: editFile, old_string: "before", new_string: "after" },
              {},
            );
          }
          yield { type: "text-delta", text: "done" };
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

describe("runTurn — file change callbacks", () => {
  it("forwards the git diff + changed files to onFileChange after an edit", async () => {
    const ws = new MemoryWorkspace({ "src/e.ts": "before" });
    const changes: Array<{ diff: string; changedFiles: string[] }> = [];

    await runTurn({
      prompt: "rename before to after in src/e.ts",
      workspace: ws,
      ai: makeAi("src/e.ts"),
      bare: true,
      onFileChange: (diff, changedFiles) =>
        changes.push({ diff, changedFiles }),
    });

    expect(changes.length).toBeGreaterThan(0);
    const last = changes[changes.length - 1]!;
    expect(last.changedFiles).toContain("src/e.ts");
    expect(last.diff).toContain("src/e.ts");
  });

  it("fires onFileEdit per landed edit, carrying the create/update kind and the edit-integrity anchor chain", async () => {
    const ws = new MemoryWorkspace({ "src/e.ts": "before" });
    const edits: Array<{
      path: string;
      kind: string;
      bytes: number;
      beforeHash?: string;
      afterHash?: string;
      replacements?: number;
    }> = [];

    await runTurn({
      prompt: "rename before to after in src/e.ts",
      workspace: ws,
      ai: makeAi("src/e.ts"),
      bare: true,
      onFileEdit: (e) => edits.push(e),
    });

    const edit = edits.find((e) => e.path === "src/e.ts");
    expect(edit).toBeDefined();
    expect(edit).toMatchObject({
      path: "src/e.ts",
      kind: "update",
      bytes: "after".length,
      replacements: 1,
    });
    // The edit-integrity anchor chain must be threaded through the pipeline's
    // onFileEdit rebuild, not silently dropped.
    expect(edit?.beforeHash).toMatch(/^[0-9a-f]{16}$/);
    expect(edit?.afterHash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("runTurn — bare mode model accounting", () => {
  it("labels/accounts an unpinned, high-stakes bare run with DEFAULT_AGENT_MODEL, matching what actually executes", async () => {
    // Regression test: runBare's accounting used to compute the label via
    // modelForTier("balanced") (Sonnet) while the actual execution call below
    // it passed `opts.model` through as-is — undefined when unpinned, which
    // fell through to runCodingAgent's OWN internal default
    // (DEFAULT_AGENT_MODEL, Fable 5). The label silently diverged from what
    // ran. Assert BOTH sides agree: the model the stream() call actually
    // received, and the label recorded on the trace. A prompt that matches
    // PRECISE_DOMAINS (auth) still floors to the frontier tier — same slug as
    // DEFAULT_AGENT_MODEL — so this also covers the classifyTier escalation
    // path (Perf #8), not just the old hard-default.
    const ws = new MemoryWorkspace({ "a.ts": "x" });
    let modelUsed: string | undefined;
    const ai: AgentAi = {
      stream(args: ModelRunArgs) {
        modelUsed = args.model;
        return {
          fullStream: (async function* () {
            yield { type: "text-delta", text: "done" };
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

    // ONE prompt drives both the run and the oracle — a high-stakes ask that
    // classifyTier floors to the precise tier. (Previously a stale `prompt`
    // variable classified a different, trivial string than the one actually
    // run, so the oracle and execution diverged the moment the tier→model map
    // shifted — a latent test bug, not a routing bug.)
    const prompt = "fix the authentication bug in the login flow";
    const result = await runTurn({
      prompt,
      workspace: ws,
      ai,
      bare: true,
      // No `model` passed — the label AND the actual execution must both
      // resolve to the router's tier for this prompt (never diverge).
    });

    const expected = modelForTier(classifyTier({ text: prompt }).tier);
    expect(modelUsed).toBe(expected);
    expect(result.trace.selectedModel).toBe(expected);
    // The whole point: label == execution.
    expect(result.trace.selectedModel).toBe(modelUsed);
  });

  it("routes an unpinned, trivial bare run through the classifyTier floor (Perf #8), matching what actually executes", async () => {
    // Perf #8: an unpinned bare turn no longer hard-defaults to the frontier
    // tier — a trivial, short, single-file-scoped ask routes through the same
    // deterministic classifyTier floor the full pipeline uses, so it runs on
    // the cheap tier. Assert the label and the actual execution still agree
    // (no divergence), and that it is NOT the frontier default.
    const ws = new MemoryWorkspace({ "a.ts": "x" });
    let modelUsed: string | undefined;
    const ai: AgentAi = {
      stream(args: ModelRunArgs) {
        modelUsed = args.model;
        return {
          fullStream: (async function* () {
            yield { type: "text-delta", text: "done" };
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

    const result = await runTurn({
      prompt: "do something",
      workspace: ws,
      ai,
      bare: true,
      // No `model` passed — both the label and the actual execution must
      // resolve to the SAME classifyTier-derived default.
    });

    expect(modelUsed).not.toBe(DEFAULT_AGENT_MODEL);
    expect(result.trace.selectedModel).toBe(modelUsed);
  });

  it("still labels/accounts a pinned bare run with the pinned model", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "x" });
    const result = await runTurn({
      prompt: "do something",
      workspace: ws,
      ai: makeAi(),
      bare: true,
      model: "openai/gpt-5",
    });
    expect(result.trace.selectedModel).toBe("openai/gpt-5");
  });
});

describe("runTurn — thinking-log persistence", () => {
  function aiWithReasoning(reasoning: string): AgentAi {
    return {
      stream(_args: ModelRunArgs) {
        return {
          fullStream: (async function* () {
            yield { type: "reasoning-delta", text: reasoning };
            yield { type: "text-delta", text: "done" };
          })(),
          steps: Promise.resolve([{}]),
          usage: Promise.resolve({
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          }),
          response: Promise.resolve({ messages: [] }),
          finishReason: Promise.resolve("stop"),
        } as unknown as ReturnType<AgentAi["stream"]>;
      },
      generateObject: async () => ({
        object: {} as never,
        usage: { totalTokens: 0 },
      }),
    };
  }

  it("persists the model's reasoning onto the trace (bare path)", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "x" });
    const result = await runTurn({
      prompt: "think about it",
      workspace: ws,
      ai: aiWithReasoning("I should check the imports before editing."),
      bare: true,
    });
    expect(result.trace.thinkingLog).toBeDefined();
    expect(result.trace.thinkingLog?.[0]?.text).toContain("check the imports");
    expect(result.trace.thinkingLog?.[0]?.round).toBe(0);
  });

  it("omits the thinking log when the model emits no reasoning", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "x" });
    const result = await runTurn({
      prompt: "no reasoning here",
      workspace: ws,
      ai: makeAi(),
      bare: true,
    });
    expect(result.trace.thinkingLog).toBeUndefined();
  });
});
