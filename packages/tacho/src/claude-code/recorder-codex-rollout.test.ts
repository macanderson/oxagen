/**
 * A Codex session's recorder reads its rollout with the Codex reader: one
 * `llm_call` per response, stamped a later sighting of the gateway's frame
 * for the same response, nothing for a line read twice, and the subagent's
 * rollout on the child chain. Fixtures are rollouts Codex 0.158 wrote, with
 * every id, path and line of text replaced (`fixtures/codex/transcript/`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TranscriptCarry } from "../codex/rollout";
import type { TachoEvent } from "../envelope";
import type { ClaudeCodeContext } from "./context";
import {
  countsLlmCallUsage,
  LLM_CALL_DUPLICATE_OF_ATTR,
} from "./llm-call-dedupe";
import { SessionRecorder } from "./recorder";

const ID = "019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b";
const SCOPE = "host-codex-rollout-test";
const at = "2026-09-30T10:00:00.000Z";
const FIXTURES = join(__dirname, "..", "..", "fixtures", "codex", "transcript");

function context(harness: "codex" | "claude-code"): ClaudeCodeContext {
  return {
    agent: {
      agent_key: `acme.core.${harness}`,
      fleet_id: "wrk_test",
      runtime: harness,
      harness,
      wrapper_version: "2.1.1",
    },
    now: () => Date.parse(at),
  };
}

function lines(name: string): string[] {
  return readFileSync(join(FIXTURES, name), "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

/** The response ids the fixture's usage records carry, in order. */
function responseIds(name: string, from = 0): string[] {
  return lines(name)
    .map(
      (line) =>
        JSON.parse(line) as {
          ordinal: number;
          type: string;
          payload: { response_id?: string };
        },
    )
    .filter((record) => record.type === "token_usage_record")
    .filter((record) => record.ordinal >= from)
    .map((record) => record.payload.response_id ?? "");
}

function started(harness: "codex" | "claude-code" = "codex"): SessionRecorder {
  const chain = new SessionRecorder({
    context: context(harness),
    harnessSessionId: ID,
    scope: SCOPE,
  });
  chain.ingestHook(
    {
      session_id: ID,
      hook_event_name: "SessionStart",
      cwd: "/home/dev/proj",
      model: "gpt-6-astra",
      permission_mode: "default",
      source: "startup",
    },
    {},
    at,
  );
  return chain;
}

function read(
  chain: SessionRecorder,
  name: string,
  carry: TranscriptCarry,
  subagentId?: string,
): TachoEvent[] {
  return lines(name).flatMap((line) =>
    chain.ingestTranscriptLine(line, subagentId, carry),
  );
}

type LlmCallEvent = Extract<TachoEvent, { kind: "llm_call" }>;

function calls(events: readonly TachoEvent[]): LlmCallEvent[] {
  return events.filter(
    (event): event is LlmCallEvent => event.kind === "llm_call",
  );
}

describe("SessionRecorder with a Codex rollout", () => {
  it("seals one transcript llm_call per response, each with its body digest", () => {
    const chain = started();
    const carry: TranscriptCarry = {};
    const sealed = calls(read(chain, "tool-calls.jsonl", carry));
    expect(sealed.map((event) => event.body.message_id)).toEqual(
      responseIds("tool-calls.jsonl"),
    );
    expect(sealed.every((event) => event.source === "transcript")).toBe(true);
    expect(sealed.every((event) => countsLlmCallUsage(event))).toBe(true);
    for (const event of sealed)
      expect(event.content?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(carry.codex?.model).toBe("gpt-6-astra");
    expect(carry.codex?.held).toBeUndefined();
  });

  it("stamps a response the gateway already sealed as a later sighting of it", () => {
    const chain = started();
    const [first] = responseIds("tool-calls.jsonl");
    // The proxy's frame for the same response: `message_id` is the
    // Responses API `response.id`, the id the rollout's usage record carries.
    const proxy = chain.sealCollectorEvent(
      "llm_call",
      {
        provider: "openai",
        model: "gpt-6-astra",
        message_id: first,
        request_id: "req_0000000000000001",
        input_tokens: 10,
        output_tokens: 5,
      },
      { fidelity: "proxy" },
    );
    expect(countsLlmCallUsage(proxy)).toBe(true);
    const sealed = calls(read(chain, "tool-calls.jsonl", {}));
    expect(sealed).toHaveLength(3);
    expect(sealed[0]?.attrs[LLM_CALL_DUPLICATE_OF_ATTR]).toBe("collector");
    expect(countsLlmCallUsage(sealed[0] as LlmCallEvent)).toBe(false);
    // Its text still ships: the proxy's frame holds the wire bytes, this one
    // the response as Codex recorded it.
    expect(sealed[0]?.content?.digest).toMatch(/^sha256:/);
    // The calls the gateway did not see count as they are.
    expect(sealed.slice(1).every((event) => countsLlmCallUsage(event))).toBe(
      true,
    );
  });

  it("seals nothing for a rollout read a second time", () => {
    const chain = started();
    expect(calls(read(chain, "tool-calls.jsonl", {}))).toHaveLength(3);
    // A cursor restored from before its last seal reads the same lines
    // again, with the state it had then.
    expect(calls(read(chain, "tool-calls.jsonl", {}))).toEqual([]);
  });

  it("seals a subagent's rollout on the child chain", () => {
    const chain = started();
    const child = "019a2b3c-4d5e-7f60-8a9b-000000000003";
    const sealed = calls(read(chain, "subagent-fork.jsonl", {}, child));
    expect(sealed.map((event) => event.body.message_id)).toEqual(
      responseIds("subagent-fork.jsonl", 9),
    );
    expect(sealed).toHaveLength(2);
    expect(
      sealed.every((event) => event.subagent?.subagent_id === child),
    ).toBe(true);
  });

  it("reads a Claude Code session's transcript as before, and keeps no state", () => {
    const chain = started("claude-code");
    const carry: TranscriptCarry = {};
    const sealed = calls(read(chain, "tool-calls.jsonl", carry));
    expect(sealed).toEqual([]);
    expect(carry).toEqual({});
  });
});
