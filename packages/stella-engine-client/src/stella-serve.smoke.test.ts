/**
 * The one test that talks to a real `stella-serve`.
 *
 * Every other test here runs against `fake-engine.ts`, which imitates the
 * server's observed behaviour. This test is what keeps the imitation honest:
 * it boots the binary named by `STELLA_SERVE_BIN`, drives the same scripted
 * turn the fake replays, and asserts the same facts. Skipped when the
 * variable is unset, so the unit suite never depends on a Rust build; CI sets
 * it from the pinned image.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EngineHttpError, StellaEngineClient } from "./client";
import { driveTurn } from "./drive-turn";
import {
  goldenDelta,
  goldenProviderAnswer,
  goldenToolAnswer,
} from "./fake-engine";
import { STELLA_SERVE_PINNED_VERSION } from "./version";
import type { AgentEvent, ToolContractWire } from "./wire";

const bin = process.env.STELLA_SERVE_BIN;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

describe.skipIf(!bin)("stella-serve smoke (STELLA_SERVE_BIN)", () => {
  let child: ChildProcess;
  let client: StellaEngineClient;
  const token = randomBytes(24).toString("hex");
  const stderr: string[] = [];

  beforeAll(async () => {
    const port = await freePort();
    child = spawn(bin!, [], {
      env: {
        ...process.env,
        STELLA_SERVE_BIND: `127.0.0.1:${port}`,
        STELLA_SERVE_TOKEN: token,
        STELLA_SERVE_TOOLS: "remote",
        STELLA_SERVE_LOG: "warn",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
    client = new StellaEngineClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token,
    });
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        const ready = await client.ready();
        if (ready.ready) break;
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline) {
        throw new Error(
          `stella-serve did not become ready:\n${stderr.join("")}`,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 30_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    child?.kill("SIGKILL");
  });

  it("reports a version at or above the pin", async () => {
    const version = await new Promise<string>((resolve, reject) => {
      const probe = spawn(bin!, ["--version"]);
      let out = "";
      probe.stdout.on("data", (c: Buffer) => (out += c.toString()));
      probe.on("close", () => resolve(out.trim()));
      probe.on("error", reject);
    });
    expect(version).toMatch(/^stella-serve \d+\.\d+\.\d+$/);
    const [, semver] = version.split(" ");
    expect(
      semver!.localeCompare(STELLA_SERVE_PINNED_VERSION, undefined, {
        numeric: true,
      }),
    ).toBeGreaterThanOrEqual(0);
  });

  it("drives the golden turn through a session, with a contract, a delta and a late answer", async () => {
    const { session_id } = await client.createSession({
      system_prompt: "You are the Oxagen assistant.",
      budget: { mode: "off" },
    });
    const contract: ToolContractWire = {
      version: 1,
      schema: {
        name: "search_nodes",
        description: "Search graph nodes",
        input_schema: {
          type: "object",
          properties: { q: { type: "string" } },
          required: ["q"],
        },
        read_only: true,
      },
      risk: "low",
      requires_approval: false,
      provenance: "declared",
    };
    const events: AgentEvent["type"][] = [];
    const roles: string[] = [];
    let step = 0;
    const result = await driveTurn(client, {
      sessionId: session_id,
      request: {
        provider_id: "openrouter",
        principal: "user-1",
        input: [{ role: "user", content: "list the nodes" }],
        tools: [contract],
      },
      handlers: {
        onProviderRequest: async (req, ctx) => {
          roles.push(req.role);
          step += 1;
          // The real engine numbers request ids per turn instance; the golden
          // answers are keyed by step, not by the id.
          const key = step === 1 ? "prov-1-0" : "prov-1-1";
          if (step === 2) {
            expect(req.request.messages.at(-1)).toMatchObject({ role: "tool" });
            await ctx.deltas(goldenDelta);
          } else {
            expect(req.request.tools?.[0]).toMatchObject({
              name: "search_nodes",
              read_only: true,
            });
          }
          return goldenProviderAnswer(key);
        },
        onToolRequest: async (req) => {
          expect(req).toMatchObject({
            name: "search_nodes",
            input: { q: "nodes" },
          });
          return goldenToolAnswer;
        },
        onEvent: (event) => events.push(event.type),
      },
    });

    expect(result.outcome).toEqual({
      status: "completed",
      text: "There are 3 nodes.",
      cost_usd: 0.002,
    });
    expect(result.providerCalls).toBe(2);
    expect(result.toolCalls).toBe(1);
    expect(roles).toEqual(["worker", "worker"]);
    expect(result.clamped).toEqual([]);
    expect(events).toEqual(
      expect.arrayContaining([
        "tool_start",
        "tool_result",
        "text_delta",
        "text",
        "turn_complete",
      ]),
    );

    const view = await client.getSession(session_id);
    expect(view.turns_completed).toBe(1);
    expect(view.live_turn).toBeNull();
    expect(view.messages).toEqual([
      { role: "system", content: "You are the Oxagen assistant." },
      { role: "user", content: "list the nodes" },
      {
        role: "assistant",
        tool_calls: [
          { call_id: "call_1", name: "search_nodes", input: { q: "nodes" } },
        ],
      },
      {
        role: "tool",
        tool_results: [
          { call_id: "call_1", output: { ok: { content: "[n1,n2,n3]" } } },
        ],
      },
      { role: "assistant", content: "There are 3 nodes." },
    ]);

    const late = await client
      .resolveTool(result.turnId, "tool-0-0", { ok: { content: "x" } })
      .catch((e: unknown) => e);
    expect((late as EngineHttpError).status).toBe(404);
    expect(await client.cancelTurn(result.turnId)).toBe(false);
    expect(await client.deleteSession(session_id)).toEqual({
      status: "deleted",
    });
  }, 30_000);

  it("refuses an answer that arrives before its request is outstanding with 409", async () => {
    const { turn_id } = await client.startStatelessTurn({
      provider_id: "openrouter",
      messages: [{ role: "user", content: "hi" }],
    });
    const err = await client
      .resolveTool(turn_id, "tool-never", { ok: { content: "" } })
      .catch((e: unknown) => e);
    expect((err as EngineHttpError).status).toBe(409);
    expect(await client.cancelTurn(turn_id)).toBe(true);
  });
});
