/**
 * Integration smoke test (oxagen #1081, made real by #1132): boot a real
 * `stella-serve` binary and drive a **complete multi-step agentic turn**
 * through it, with this test acting as the host — it owns the model and it owns
 * the tools, exactly as oxagen's kernel will.
 *
 * This is the test #1132 exists for. Its predecessor asserted a
 * session-oriented HTTP surface that `stella-serve` has never served, and had
 * no way to answer a reverse-RPC request, so it could not have driven a turn
 * even against the right routes — and because its capability probe looked for a
 * nonexistent `stella serve` subcommand, it skipped in every environment and
 * that was never discovered. See wire-types.ts for the drift table.
 *
 * ## Why this needs no API key and no network
 *
 * `stella-serve` depends on `stella-protocol` + `stella-core` only — no HTTP
 * client, no TLS, no provider adapters. It is *structurally incapable* of
 * calling a model. Every model call and every tool call is a reverse-RPC
 * request the host answers. So this test is fully deterministic and offline:
 * the "model" below is a two-element script, and the engine's orchestration is
 * the only thing under test.
 *
 * ## What turns this red
 *
 * A rename or restructure anywhere on the wire: the frame tag (`type`), the
 * frame variant names, `request_id`, the flattened `status` on a provider
 * result, `ToolOutput`'s external tagging, `TurnOutcomeWire`'s `status` tag, or
 * the `role`/`tool_calls`/`tool_results` shape of the conversation the engine
 * assembles. It also goes red if the engine stops threading tool output back
 * into the next model call — the property that makes it an agent loop at all.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { StellaSidecarClient } from "./sidecar-transport.js";
import { readSidecarConfig, resolveStellaBinary } from "./stella-binary.js";
import { isTerminalTurnEvent } from "./wire-types.js";
import type {
  CompletionRequest,
  CompletionResult,
  ToolOutput,
  TurnRequest,
} from "./wire-types.js";

/** 32+ chars so the server does not warn about a guessable token. */
const TOKEN = "oxagen-smoke-test-bearer-token-0123456789";

const config = readSidecarConfig();
const resolution = await resolveStellaBinary(config);

// The ONLY skip condition is an absent binary (oxagen #1081: a missing Stella
// must never fail the suite hard). A version mismatch deliberately does NOT
// skip — the assertions below are the drift detector, and skipping on mismatch
// is what made the nightly `latest` job permanently skip-green.
const skipReason = resolution
  ? undefined
  : `no stella-serve binary found (checked $${config.binaryEnvVar}, ` +
    `$${config.legacyBinaryEnvVar}, and \`${config.binaryName}\` on PATH) — ` +
    `build one with \`cargo build -p stella-serve --bin stella-serve\` in the ` +
    `stella checkout and point $${config.binaryEnvVar} at it`;

if (skipReason) {
  // Explicit, named skip: shows up in the run summary as SKIPPED with the
  // exact missing-requirement reason, not a silent pass.
  test.skip(`stella-serve <-> sidecar host round trip (SKIPPED: ${skipReason})`, () => {});
} else {
  const binary = resolution!;

  describe("stella-serve <-> sidecar host round trip", () => {
    let child: ChildProcess;
    let client: StellaSidecarClient;

    beforeAll(async () => {
      // Bind port 0 and read the port back off the server's own startup line.
      // Picking a random port and hoping it is free is the classic source of
      // flake in a test like this; the kernel already knows a free one.
      child = spawn(binary.path, [], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          STELLA_SERVE_BIND: "127.0.0.1:0",
          STELLA_SERVE_TOKEN: TOKEN,
          STELLA_SERVE_TOOLS: "remote",
        },
      });
      const baseUrl = await readBoundAddress(child, config.readinessTimeoutMs);
      client = new StellaSidecarClient({ baseUrl, token: TOKEN });
      expect(
        await client.health(),
        "GET /healthz must answer 200 once the server has bound",
      ).toBe(true);
      if (!binary.matchesPin) {
        console.warn(
          `[stella-sidecar] running against stella-serve ` +
            `${binary.reportedVersion ?? "unknown"}, pinned ` +
            `${config.stellaVersion} — asserting the contract anyway`,
        );
      }
    });

    afterAll(() => {
      child?.kill("SIGTERM");
    });

    test("the host drives a two-step tool-using turn to completion", async () => {
      // The host's "model": call the tool, then answer from its result.
      const modelReplies: CompletionResult[] = [
        {
          text: "",
          tool_calls: [
            {
              call_id: "call-weather-1",
              name: "get_weather",
              input: { city: "Paris" },
            },
          ],
          usage: { reported: true, input_tokens: 42, output_tokens: 17 },
          model: "oxagen-host-scripted",
          cost_usd: 0.0002,
          // `tool_calls`, never `tool_use` — the latter is Anthropic's spelling
          // and stella rejects it with a 400 naming the valid variants.
          finish_reason: "tool_calls",
        },
        {
          text: "It is 18C and clear in Paris.",
          usage: { reported: true, input_tokens: 96, output_tokens: 12 },
          model: "oxagen-host-scripted",
          cost_usd: 0.0003,
          finish_reason: "stop",
        },
      ];

      const conversations: CompletionRequest[] = [];
      const toolInvocations: { name: string; input: unknown }[] = [];

      const request: TurnRequest = {
        provider_id: "oxagen-host",
        tools: [
          {
            name: "get_weather",
            description: "Look up the current weather for a city.",
            input_schema: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
            read_only: true,
          },
        ],
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "What is the weather in Paris?" },
        ],
        budget: { mode: "off" },
        max_steps: 10,
        reverse_request_timeout_ms: 20_000,
      };

      const run = await client.runTurn(request, {
        onProviderRequest: async (completion) => {
          conversations.push(completion);
          const reply = modelReplies[conversations.length - 1];
          if (!reply) {
            throw new Error(
              `engine asked for model call #${conversations.length}; the ` +
                `script has ${modelReplies.length}`,
            );
          }
          return reply;
        },
        onToolRequest: async (name, input): Promise<ToolOutput> => {
          toolInvocations.push({ name, input });
          const city = (input as { city?: string }).city ?? "nowhere";
          return { ok: { content: `18C, clear skies in ${city}.` } };
        },
      });

      // --- the loop actually looped ---
      expect(
        run.providerCalls,
        "the engine must make a second model call after the tool result",
      ).toBe(2);
      expect(run.toolCalls, "the engine must dispatch the tool call").toBe(1);
      expect(toolInvocations).toEqual([
        { name: "get_weather", input: { city: "Paris" } },
      ]);

      // --- the terminal frame ---
      expect(run.outcome.status).toBe("completed");
      if (run.outcome.status !== "completed") throw new Error("unreachable");
      expect(run.outcome.text).toBe("It is 18C and clear in Paris.");
      // Cost is settled by the engine from what the HOST reported on each call,
      // which is what makes oxagen the metering authority rather than a
      // consumer of stella's estimate.
      expect(run.outcome.cost_usd).toBeCloseTo(0.0005, 10);

      // --- the load-bearing assertion: this is what makes it an agent loop ---
      // Model call #2 must contain the tool result the host produced, threaded
      // in by the engine as a proper `tool` message. If this breaks, stella is
      // no longer functioning as an agent engine, whatever else still passes.
      const second = conversations[1];
      expect(
        second,
        "a second CompletionRequest must have been raised",
      ).toBeDefined();
      expect(second!.messages.map((m) => m.role)).toEqual([
        "system",
        "user",
        "assistant",
        "tool",
      ]);
      const assistant = second!.messages[2]!;
      expect(assistant.tool_calls).toEqual([
        {
          call_id: "call-weather-1",
          name: "get_weather",
          input: { city: "Paris" },
        },
      ]);
      const toolMessage = second!.messages[3]!;
      expect(toolMessage.tool_results).toEqual([
        {
          call_id: "call-weather-1",
          // Externally tagged: `{ok: {...}}`, NOT `{status: "ok", ...}` and
          // NOT an `is_error` boolean.
          output: { ok: { content: "18C, clear skies in Paris." } },
        },
      ]);

      // The engine advertises the host's tool set back on the model call, so a
      // host that forwards to a real provider has the schemas it needs.
      expect(second!.tools?.map((t) => t.name)).toEqual(["get_weather"]);

      // --- the AgentEvent stream reached the host ---
      const eventTypes = new Set(run.events.map((e) => e.type));
      for (const expected of ["tool_start", "tool_result", "text"]) {
        expect(
          eventTypes.has(expected),
          `expected a \`${expected}\` AgentEvent; saw ${[...eventTypes].join(", ")}`,
        ).toBe(true);
      }

      // The terminal event, under whichever tag this build uses. The pinned
      // 0.6.2 build sends `complete`; stella `main` renamed it `turn_complete`.
      // Asserting one tag passes against one workflow and fails against the
      // other — which is how this assertion reddened stella-sidecar-nightly
      // while stella-sidecar stayed green.
      expect(
        run.events.some(isTerminalTurnEvent),
        `expected a terminal AgentEvent (\`complete\` or \`turn_complete\`); saw ${[...eventTypes].join(", ")}`,
      ).toBe(true);
    });

    test("every route except /healthz refuses an absent bearer token", async () => {
      const url = client.baseUrl;
      const res = await fetch(`${url}/v1/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider_id: "x", messages: [] }),
      });
      expect(res.status).toBe(401);
      // The auth gate runs BEFORE routing, so even a nonexistent path is 401
      // rather than 404 when unauthenticated. Worth pinning: it means a 401 is
      // not evidence that the token is wrong.
      const bogus = await fetch(`${url}/v1/definitely-not-a-route`);
      expect(bogus.status).toBe(401);
    });

    test("a turn can be cancelled, and cancellation is idempotent", async () => {
      // Never answer the model call, so the turn stays parked and we can cancel
      // it. `cancel` is the only teardown route — there is no DELETE.
      const { turnId } = await client.createTurn({
        provider_id: "oxagen-host",
        messages: [{ role: "user", content: "hang" }],
        reverse_request_timeout_ms: 60_000,
      });
      await client.cancelTurn(turnId);
      // The id leaves the registry immediately, so a second cancel is a 404 —
      // which the client tolerates rather than throwing.
      await expect(client.cancelTurn(turnId)).resolves.toBeUndefined();
    });
  });
}

/**
 * Reads the port the server actually bound from its `listening on <addr>`
 * startup line, and returns the base URL.
 *
 * Also fails fast and loudly if the child exits during startup — a
 * misconfigured server (no token, unparseable bind) exits non-zero within
 * milliseconds, and without this the test would instead sit through the whole
 * readiness timeout and report a confusing "never became ready".
 */
function readBoundAddress(
  child: ChildProcess,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      reject(
        new Error(
          `stella-serve did not report a bound address within ${timeoutMs}ms\n` +
            `stdout: ${stdout}\nstderr: ${stderr}`,
        ),
      );
    }, timeoutMs);
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      fn();
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = /listening on (\S+)/.exec(stdout);
      if (match) finish(() => resolve(`http://${match[1]}`));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      finish(() =>
        reject(
          new Error(
            `stella-serve exited with code ${code} during startup\n` +
              `stdout: ${stdout}\nstderr: ${stderr}`,
          ),
        ),
      );
    });
    child.on("error", (err) => finish(() => reject(err)));
  });
}
