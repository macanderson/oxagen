/**
 * The Phase C branch at the seam.
 *
 * The seam was built in Phase 1 so the engine could be swapped here without
 * touching a surface. It has now been swapped for the last time: Stella is
 * what every call reaches, by default and on request, and the seam's remaining
 * job is to refuse anything else rather than quietly substituting the survivor.
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
          yield { type: "text-delta", text: "the model answered" };
        })(),
        steps: Promise.resolve([{}]),
        text: Promise.resolve("the model answered"),
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
  test("runs Stella when nothing asks for another", async () => {
    configureStellaEngine({ pool: fakePool("stella by default") });
    const result = await executeTurn(
      "chat",
      {
        workspace: new MemoryWorkspace({ "a.ts": "x" }),
        ai: answeringAi(),
        instruction: "hello",
      },
      { env: {} },
    );
    expect(result.text).toBe("stella by default");
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

  test("a run's own requested_engine is honoured", async () => {
    configureStellaEngine({ pool: fakePool("stella by request") });
    const result = await executeTurn(
      "a2a",
      { ai: answeringAi(), instruction: "hello", system: "s" },
      { requestedEngine: "stella", env: {} },
    );
    expect(result.text).toBe("stella by request");
  });

  test("a run pinning the deleted TS engine fails the turn", async () => {
    // The ask cannot be honoured and must not be quietly upgraded to Stella:
    // a run that named an engine and got a different one reports success for
    // work nobody asked for.
    await expect(
      executeTurn(
        "chat",
        {
          workspace: new MemoryWorkspace({ "a.ts": "x" }),
          ai: answeringAi(),
          instruction: "hello",
        },
        { requestedEngine: "ts", env: {} },
      ),
    ).rejects.toThrow(/"ts" engine, which was removed/);
  });

  test("a fleet flag still set to the deleted TS engine fails the turn", async () => {
    await expect(
      executeTurn(
        "chat",
        { ai: answeringAi(), instruction: "hello" },
        { env: { OXAGEN_ENGINE: "ts" } },
      ),
    ).rejects.toThrow(/"ts" engine, which was removed/);
  });

  test("a misspelled flag fails the turn instead of quietly running Stella", async () => {
    await expect(
      executeTurn(
        "chat",
        { ai: answeringAi(), instruction: "hello" },
        { env: { OXAGEN_ENGINE: "stellla" } },
      ),
    ).rejects.toThrow(/unknown engine/);
  });
});
