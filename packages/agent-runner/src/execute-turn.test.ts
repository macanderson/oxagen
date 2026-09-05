/**
 * Integration coverage for the executeTurn seam (agent-engine v2 Phase 1) —
 * the plan's exit-criterion test: prompt → engine → tool execution → events →
 * result, driven through @oxagen/agent-runner exactly the way a platform
 * surface drives it.
 *
 * Stella is the only engine now, so the seam's far side is a sidecar rather
 * than an in-process loop. What is scripted is the TRANSPORT — the sidecar's
 * turn stream — and nothing below it: the tool the engine asks for is executed
 * by the real local ToolSet, through the real dispatch guard, speculation
 * layer and edit-integrity ledger, against a real MemoryWorkspace. That is the
 * same claim the test always made, one layer out.
 */
import { describe, it, expect } from "vitest";
import {
  MemoryWorkspace,
  type AgentAi,
  type ModelRunArgs,
} from "@oxagen/agent-engine";
import { executeTurn, executePipelineTurn, type CodingEvent } from "./index";
import { configureStellaEngine, type SidecarLease } from "./stella/index";
import { createFakeSidecar, type FakeStep } from "./stella/fake-sidecar";
import { StellaSidecarClient } from "@oxagen/stella-engine-client";
import { SidecarPool } from "./stella/sidecar-pool";

/** A pool handing out a client wired to a scripted sidecar, spawning nothing. */
function fakePool(script: readonly FakeStep[]): SidecarPool {
  const fake = createFakeSidecar(script);
  const client = new StellaSidecarClient({
    baseUrl: "http://127.0.0.1:1",
    token: "t",
    fetchImpl: fake.fetchImpl,
  });
  const lease: SidecarLease = { client, release: () => undefined };
  return {
    acquire: async () => lease,
    shutdown: async () => undefined,
    size: 1,
    running: 0,
  } as unknown as SidecarPool;
}

/** A model the sidecar never has to call in these scripts. */
function idleAi(): AgentAi {
  return {
    stream(_args: ModelRunArgs) {
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", text: "" };
        })(),
        steps: Promise.resolve([{}]),
        usage: Promise.resolve({
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
        }),
        response: Promise.resolve({ messages: [] }),
        finishReason: Promise.resolve("stop"),
      } as unknown as ReturnType<AgentAi["stream"]>;
    },
    generateObject: async () =>
      ({ object: {} as never, usage: { totalTokens: 0 } }) as never,
  };
}

describe("executeTurn — bare loop (the production chat path)", () => {
  it("runs prompt → engine → tool → events → result through the seam", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "foo" });
    const events: CodingEvent[] = [];
    configureStellaEngine({
      pool: fakePool([
        {
          kind: "tool_request",
          name: "edit_file",
          input: { path: "a.ts", old_string: "foo", new_string: "bar" },
        },
        { kind: "complete", text: "done" },
      ]),
    });

    const result = await executeTurn("chat", {
      workspace: ws,
      ai: idleAi(),
      instruction: "rename foo to bar",
      onEvent: (e) => events.push(e),
    });

    // The turn's answer and the applied edit both came back through the seam.
    // (MemoryWorkspace.diff() is header-only by contract, so the edit itself
    // is asserted against the workspace content.)
    expect(result.text).toBe("done");
    expect(result.changedFiles).toEqual(["a.ts"]);
    expect(result.diff).toContain("a/a.ts");
    expect(await ws.readFile("a.ts")).toBe("bar");
    // The event stream observed the real tool execution and the final diff.
    expect(events.some((e) => e.type === "file-edit")).toBe(true);
    expect(events.some((e) => e.type === "final-diff")).toBe(true);
  });
});

describe("executePipelineTurn — judged pipeline (the repo-edit path)", () => {
  it("runs the full evaluate→execute→judge pipeline through the seam", async () => {
    const ai: AgentAi = {
      stream() {
        return {
          fullStream: (async function* () {
            yield { type: "text-delta", text: "pipeline done" };
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
      generateObject: (args: { system?: string }) => {
        if (args.system?.includes("evaluation stage")) {
          return Promise.resolve({
            object: {
              completeness: 70,
              complexity: 40,
              recommendedTier: "balanced",
              missing: [],
              refinedPrompt: "refined prompt",
              removed: [],
              reasoning: "well scoped",
            },
            usage: { inputTokens: 1, outputTokens: 1 },
          }) as never;
        }
        // Judge branch: always complete — no revise round in this smoke test.
        return Promise.resolve({
          object: {
            complete: true,
            confidence: 90,
            findings: [],
            remainingWork: [],
            reasoning: "looks done",
          },
          usage: { inputTokens: 1, outputTokens: 1 },
        }) as never;
      },
    };

    configureStellaEngine({
      pool: fakePool([{ kind: "complete", text: "pipeline done" }]),
    });
    const result = await executePipelineTurn("repo-edit", {
      prompt: "say done",
      workspace: new MemoryWorkspace({}),
      ai,
    });

    expect(result.text).toBe("pipeline done");
    expect(result.trace).toBeDefined();
  });
});
