/**
 * The Phase C branch at the seam.
 *
 * The seam was built in Phase 1 so the engine could be swapped here without
 * touching a surface. These tests assert exactly that: the same call, with the
 * same options, reaches a different engine purely on the flag — and reaches the
 * TS engine by default, which is what every deployment still runs.
 */
import { describe, expect, test } from "vitest";
import {
  MemoryWorkspace,
  type AgentAi,
  type ModelRunArgs,
} from "@oxagen/agent-engine";
import { executeTurn } from "../execute-turn";
import { configureStellaEngine, type SidecarLease } from "./index";
import { createFakeSidecar } from "./fake-sidecar";
import { StellaSidecarClient } from "@oxagen/stella-engine-client";
import { SidecarPool } from "./sidecar-pool";

/** A model that answers in one step, touching nothing. */
function answeringAi(): AgentAi {
  return {
    stream(_args: ModelRunArgs) {
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", text: "ts engine answered" };
        })(),
        steps: Promise.resolve([{}]),
        text: Promise.resolve("ts engine answered"),
        toolCalls: Promise.resolve([]),
        usage: Promise.resolve({
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
        }),
        response: Promise.resolve({ messages: [] }),
        finishReason: Promise.resolve("stop"),
      } as unknown as ReturnType<AgentAi["stream"]>;
    },
    generateObject: async () => ({ object: {} as never, usage: {} }) as never,
  };
}

/** A pool that hands out a client wired to a scripted engine, spawning nothing. */
function fakePool(text: string): SidecarPool {
  const fake = createFakeSidecar([{ kind: "complete", text }]);
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

describe("executeTurn engine selection", () => {
  test("runs the TS engine when nothing asks for another", async () => {
    const result = await executeTurn(
      "chat",
      {
        workspace: new MemoryWorkspace({ "a.ts": "x" }),
        ai: answeringAi(),
        instruction: "hello",
      },
      { env: {} },
    );
    expect(result.text).toBe("ts engine answered");
  });

  test("routes to Stella on the process flag, with no surface change", async () => {
    configureStellaEngine({ pool: fakePool("stella engine answered") });
    const result = await executeTurn(
      "chat",
      {
        ai: answeringAi(),
        instruction: "hello",
        system: "be helpful",
      },
      { env: { OXAGEN_ENGINE: "stella" } },
    );
    // Same call shape, same result shape — a different engine ran it.
    expect(result.text).toBe("stella engine answered");
  });

  test("a run's own requested_engine wins over the process flag", async () => {
    configureStellaEngine({ pool: fakePool("stella by request") });
    const result = await executeTurn(
      "a2a",
      { ai: answeringAi(), instruction: "hello", system: "s" },
      { requestedEngine: "stella", env: { OXAGEN_ENGINE: "ts" } },
    );
    expect(result.text).toBe("stella by request");
  });

  test("a run may pin the TS engine while the fleet default is Stella", async () => {
    const result = await executeTurn(
      "chat",
      {
        workspace: new MemoryWorkspace({ "a.ts": "x" }),
        ai: answeringAi(),
        instruction: "hello",
      },
      { requestedEngine: "ts", env: { OXAGEN_ENGINE: "stella" } },
    );
    expect(result.text).toBe("ts engine answered");
  });

  test("a misspelled flag fails the turn instead of quietly running the TS engine", async () => {
    await expect(
      executeTurn(
        "chat",
        { ai: answeringAi(), instruction: "hello" },
        { env: { OXAGEN_ENGINE: "stellla" } },
      ),
    ).rejects.toThrow(/unknown engine/);
  });
});
