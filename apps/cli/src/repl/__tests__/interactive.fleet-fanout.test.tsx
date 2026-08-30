/**
 * End-to-end TUI proof: a multi-task prompt planned for real and fanned out to
 * fleet subagents, all inside the REAL ReplApp.
 *
 * Unlike the other interactive suites this does NOT mock `runTurn` or the
 * fleet — the real per-turn planner path (plan-turn.ts), the real Fleet
 * orchestrator, and the real engine loop all execute; only the model responses
 * are canned via the injected AgentAi port (the planner's `generateObject`
 * returns a fixed 3-task plan; each subagent's `stream` yields plain text).
 * The rendered frames therefore prove the actual TUI behaviour: the ☰ [Plan]
 * stage, the plan announcement, one transcript line per finished subagent,
 * and the end-of-fleet summary.
 *
 * Set PROOF_OUT=<file> to dump the milestone frames (used as a verification
 * artifact for the runtime-proof discipline).
 */
import { appendFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import type { AgentAi } from "@oxagen/agent-engine";

/** Canned AI port: planner → fixed 3-task plan; executor → plain text. */
const cannedAi: AgentAi = {
  stream: () =>
    ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "Completed the task." };
      })(),
      steps: Promise.resolve([{}]),
      usage: Promise.resolve({
        inputTokens: 5,
        outputTokens: 7,
        totalTokens: 12,
      }),
      response: Promise.resolve({ messages: [] }),
    }) as unknown as ReturnType<AgentAi["stream"]>,
  generateObject: async <T,>() =>
    ({
      object: {
        tasks: [
          {
            id: "write-alpha",
            title: "Write the alpha module",
            description: "Create the alpha module.",
            dependsOn: [],
            files: [],
            tier: "fast",
          },
          {
            id: "write-beta",
            title: "Write the beta module",
            description: "Create the beta module.",
            dependsOn: [],
            files: [],
            tier: "fast",
          },
          {
            id: "write-gamma",
            title: "Write the gamma module",
            description: "Create the gamma module.",
            dependsOn: [],
            files: [],
            tier: "fast",
          },
        ],
      } as unknown as T,
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    }) as never,
};

vi.mock("../../agent/adapters/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agent/adapters/index.js")>()),
  // The synthetic session routes both the REPL turn AND the fleet subagents
  // through the gateway port — swap it for the canned one (no network).
  createGatewayAgentAi: () => cannedAi,
}));

// Keep the harness hermetic: no tree-sitter build, no disk stores, no MCP.
vi.mock("../../agent/code-graph.js", () => ({
  queryCodeGraph: async () => "",
  warmCodeGraph: () => {},
}));
vi.mock("../../slash/expand.js", () => ({ loadAndExpand: () => null }));
vi.mock("../../project/init.js", () => ({
  isProjectInitialized: () => true,
  initializeProject: async () => true,
}));
vi.mock("../../agent/trace-store.js", () => ({
  openTraceStore: () => ({
    record: () => {},
    get: () => undefined,
    list: () => [],
    last: () => undefined,
    resolve: () => undefined,
  }),
}));
vi.mock("../../agent/fleet/memory.js", async (importOriginal) => ({
  // Real module first: the subagent prompt enhancer uses formatLessons etc.
  ...(await importOriginal<typeof import("../../agent/fleet/memory.js")>()),
  openFleetMemory: () => ({
    record: () => {},
    recall: () => [],
    all: () => [],
  }),
}));
vi.mock("../../agent/fleet/store.js", () => ({
  openPlanStore: () => ({
    save: () => {},
    updateTask: () => {},
    setStatus: () => {},
    get: () => undefined,
    list: () => [],
  }),
}));
vi.mock("../../agent/memory.js", () => ({
  openSessionMemory: async () => ({
    remember: async () => {},
    recallContext: async () => "",
    close: async () => {},
  }),
}));
vi.mock("../../agent/turn-extras.js", () => ({
  buildTurnExtras: async () => ({
    systemAppend: "",
    extraTools: undefined,
    wrapTools: (tools: unknown) => tools,
    closeMcp: async () => {},
  }),
}));

const { ReplApp } = await import("../interactive.js");

// Synthetic session: gateway port (mocked above), no graph sync, no server memory.
const SESSION = {
  token: "synthetic",
  orgSlug: "proof",
  workspaceSlug: "proof",
  apiUrl: "http://localhost:0",
  synthetic: true,
};

const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));
// This suite drives the REAL planner + Fleet orchestrator + engine loop (only
// the model responses are canned), so each milestone is materially slower than
// the mocked-runTurn suites — and slower still under several parallel Ink suites
// on a loaded 2-core CI runner, where 20s was not enough headroom for the
// fan-out to settle. Raise the per-milestone deadline (and the per-test ceiling
// below) generously.
async function waitFor(
  cond: () => boolean,
  frame: () => string,
  ms = 30_000,
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) {
      throw new Error(`waitFor: condition timed out; last frame:\n${frame()}`);
    }
    await tick(10);
  }
}

describe("TUI fleet fan-out (real planner path + real Fleet, canned AI)", () => {
  it("plans a multi-task prompt and runs it as parallel subagents", async () => {
    const { stdin, lastFrame } = render(
      <ReplApp options={{ session: SESSION, readOnly: true }} />,
    );
    await tick();

    const proof: string[] = [];
    const snap = (label: string): void => {
      const frame = lastFrame() ?? "";
      proof.push(`\n───── ${label} ─────\n${frame}`);
    };

    stdin.write("build the alpha, beta and gamma modules");
    await tick();
    stdin.write("\r");

    // The ☰ [Plan] stage chip appears while the planner call runs.
    await waitFor(
      () => (lastFrame() ?? "").includes("Planning the work"),
      () => lastFrame() ?? "",
    );
    snap("planning stage");

    // The real plan (3 tasks) is announced and dispatched to subagents.
    await waitFor(
      () =>
        (lastFrame() ?? "").includes("Planned 3 tasks — dispatching subagents"),
      () => lastFrame() ?? "",
    );
    snap("plan announced");

    // Every subagent finishes and reports into the transcript.
    await waitFor(
      () => {
        const f = lastFrame() ?? "";
        return (
          f.includes("Write the alpha module — done") &&
          f.includes("Write the beta module — done") &&
          f.includes("Write the gamma module — done")
        );
      },
      () => lastFrame() ?? "",
    );

    // The end-of-fleet summary lands as the assistant reply.
    await waitFor(
      () => (lastFrame() ?? "").includes("3/3 tasks done"),
      () => lastFrame() ?? "",
    );
    snap("fleet complete");

    const final = lastFrame() ?? "";
    expect(final).toContain("Planned 3 tasks — dispatching subagents");
    expect(final).toContain("✓ Write the alpha module");
    expect(final).toContain("✓ Write the beta module");
    expect(final).toContain("✓ Write the gamma module");
    expect(final).toContain("3/3 tasks done");
    // No hardcoded stage-title checklist anywhere.
    expect(final).not.toContain("Evaluate the request");
    expect(final).not.toContain("Enhance the prompt");

    if (process.env["PROOF_OUT"]) {
      appendFileSync(process.env["PROOF_OUT"], proof.join("\n"));
    }
  }, 60_000);
});
