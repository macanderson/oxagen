/**
 * The text a live hook answer hands the agent after its start is noted on the
 * session's recorder, so each later model call on the session's conversation
 * carries it as `context_frame_tokens` (#5339). The calls here reach the
 * chain as OTel `api_request` records, the way a session the proxy did not
 * carry records them. The start's text is the steering manifest's to count,
 * and a replay, a subagent's hook, or an answer with no text notes nothing.
 */
import { budgetTokens } from "@contextgraphprotocol/typescript-sdk";
import { describe, expect, it } from "vitest";
import type { ClaudeCodeContext } from "../claude-code/context";
import type { TachoEvent } from "../envelope";
import {
  bundleSigner,
  TEST_ENROLLMENT,
  unsignedBundle,
} from "../host/test-support";
import {
  handleHookEvent,
  type HookHandlerDeps,
  type PolicyView,
  RECALL_HEADING,
} from "./hook-handler";
import type { RecalledMemory } from "./memory-capture/memory-recall";
import {
  type QueuedPrompt,
  type SessionRecord,
  SessionRegistry,
} from "./registry";

const CONTEXT: ClaudeCodeContext = {
  agent: {
    agent_key: "acme.core.cc-laptop",
    fleet_id: "wrk_1",
    runtime: "claude-code",
    harness: "claude-code",
    wrapper_version: "2.1.1",
    host_enrollment_id: TEST_ENROLLMENT,
  },
};

const SESSION = "sess-context-frames";

const MEMORIES: RecalledMemory[] = [
  { id: "mem_01", statement: "Use pnpm, never npm." },
];
const RECALLED = `${RECALL_HEADING}\n- Use pnpm, never npm.`;

/** The hooks below run from 01:00; this call is made an hour later. */
const CALL_AT = "2026-09-27T02:00:00.000Z";
/** A call made before the session's first hook. */
const EARLY_AT = "2026-09-27T00:30:00.000Z";

function harness(
  memories: readonly RecalledMemory[] = MEMORIES,
  system: string | null = null,
) {
  const bundle = bundleSigner().sign(unsignedBundle({ context: { system } }));
  let clock = Date.parse("2026-09-27T01:00:00.000Z");
  const now = () => (clock += 1000);
  const registry = new SessionRegistry({
    context: CONTEXT,
    scope: TEST_ENROLLMENT,
    now,
  });
  const view: PolicyView = {
    bundle,
    verified: true,
    hostStatus: "active",
    denyGeneration: bundle.deny_generation,
    controlReachable: true,
  };
  const deps: HookHandlerDeps = {
    registry,
    policy: () => view,
    acknowledge: () => undefined,
    now,
    recallMemories: async () => memories,
  };
  return { registry, deps };
}

function message(id: string, text: string): QueuedPrompt {
  return {
    id,
    text,
    command: "steer",
    requestedMode: "next_step",
    deliveryMode: "next_step",
    degradedReason: null,
    expiresAt: null,
  };
}

const start = { session_id: SESSION, hook_event_name: "SessionStart" };
const prompt = {
  session_id: SESSION,
  hook_event_name: "UserPromptSubmit",
  prompt: "How do I install?",
};
const toolDone = {
  session_id: SESSION,
  hook_event_name: "PostToolUse",
  tool_name: "Read",
  tool_input: { file_path: "/repo/README.md" },
  tool_use_id: "toolu_read",
};
const stop = { session_id: SESSION, hook_event_name: "Stop" };

async function opened(h: ReturnType<typeof harness>): Promise<SessionRecord> {
  await handleHookEvent(start, {}, h.deps);
  const record = h.registry.get(SESSION);
  if (record === undefined) throw new Error("no record");
  return record;
}

/** Claude Code's OTel record of one main-thread model call made at `iso`. */
function apiRequest(request: string, iso: string) {
  const kv = (key: string, value: string | number) =>
    typeof value === "number"
      ? { key, value: { intValue: String(value) } }
      : { key, value: { stringValue: value } };
  return {
    resourceLogs: [
      {
        resource: { attributes: [kv("os.type", "linux")] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: `${Date.parse(iso)}000000`,
                body: { stringValue: "claude_code.api_request" },
                attributes: [
                  kv("model", "claude-opus-4-5"),
                  kv("request_id", request),
                  kv("input_tokens", 10),
                  kv("output_tokens", 5),
                  kv("query_source", "repl_main_thread"),
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** The counted row of one call the proxy did not carry. */
function callRow(
  record: SessionRecord,
  request: string,
  iso = CALL_AT,
): Record<string, unknown> {
  const rows = record.recorder
    .ingestOtlp(apiRequest(request, iso))
    .filter((event: TachoEvent) => event.kind === "llm_call");
  expect(rows).toHaveLength(1);
  return (rows[0]?.body ?? {}) as Record<string, unknown>;
}

describe("the context a hook answer hands the agent (#5339)", () => {
  it("counts a prompt's recall on the calls after it", async () => {
    const h = harness();
    const record = await opened(h);
    const outcome = await handleHookEvent(prompt, {}, h.deps);
    const turn = outcome.events.find((event) => event.kind === "turn_start");
    expect(turn?.attrs["oxagen.delivered_chars"]).toBe(
      String(RECALLED.length),
    );
    const row = callRow(record, "req_1");
    expect(row["context_frame_tokens"]).toBe(budgetTokens(RECALLED));
    expect(row["context_frame_tokens_basis"]).toBe("estimated");
    // The call made before the prompt carries none of it.
    expect(callRow(record, "req_0", EARLY_AT)).not.toHaveProperty(
      "context_frame_tokens",
    );
  });

  it("writes no count, never zero, when no answer handed the agent text", async () => {
    const h = harness([]);
    const record = await opened(h);
    const outcome = await handleHookEvent(prompt, {}, h.deps);
    expect(outcome.response).toEqual({});
    const turn = outcome.events.find((event) => event.kind === "turn_start");
    expect(turn?.attrs["oxagen.delivered_chars"]).toBeUndefined();
    const row = callRow(record, "req_1");
    expect(row).not.toHaveProperty("context_frame_tokens");
    expect(row).not.toHaveProperty("context_frame_tokens_basis");
  });

  it("leaves the start's text to the steering count", async () => {
    const h = harness([], "You are governed by Oxagen. Never push to main.");
    const record = await opened(h);
    expect(callRow(record, "req_1")).not.toHaveProperty(
      "context_frame_tokens",
    );
  });

  it("adds each answer's text to the total", async () => {
    const h = harness();
    const record = await opened(h);
    await handleHookEvent(prompt, {}, h.deps);
    const steer = "Stop and read the brief before the next edit.";
    record.control.messages.push(message("cmd_tool", steer));
    const after = await handleHookEvent(toolDone, {}, h.deps);
    expect(after.response).toMatchObject({
      hookSpecificOutput: { additionalContext: steer },
    });
    const ending = "Open a draft pull request when the tests are written.";
    record.control.messages.push(message("cmd_stop", ending));
    const stopped = await handleHookEvent(stop, {}, h.deps);
    expect(stopped.response).toEqual({ decision: "block", reason: ending });
    expect(callRow(record, "req_1")["context_frame_tokens"]).toBe(
      budgetTokens(RECALLED) + budgetTokens(steer) + budgetTokens(ending),
    );
  });

  it("notes nothing for a replayed prompt, whose answer reaches no harness", async () => {
    const h = harness();
    const record = await opened(h);
    await handleHookEvent(prompt, {}, h.deps, {
      receivedAt: "2026-09-27T01:00:05.000Z",
    });
    expect(callRow(record, "req_1")).not.toHaveProperty(
      "context_frame_tokens",
    );
  });

  it("notes nothing for a subagent's hook, whose text stays in the subagent", async () => {
    const h = harness();
    const record = await opened(h);
    record.control.messages.push(message("cmd_sub", "Check the lockfile."));
    await handleHookEvent(
      { ...toolDone, agent_id: "agent-a", agent_type: "Explore" },
      {},
      h.deps,
    );
    expect(callRow(record, "req_1")).not.toHaveProperty(
      "context_frame_tokens",
    );
  });
});
