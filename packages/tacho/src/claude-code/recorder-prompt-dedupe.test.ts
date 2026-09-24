/**
 * One prompt, one body.
 *
 * Claude Code reports each prompt twice: the `UserPromptSubmit` hook, sealed
 * as `turn_start` with the prompt text as its body, and the `user` record it
 * writes to the transcript. What is asserted here is that the WAL holds the
 * text once, that the transcript frame still lands with its own facts and a
 * pointer to the `turn_start`, and that the match survives a restart and a
 * chain rollback.
 */
import { describe, expect, it } from "vitest";
import type { ClaudeCodeContext } from "./context";
import { PROMPT_DUPLICATE_OF_ATTR, SessionRecorder } from "./recorder";

const ID = "11111111-2222-3333-4444-777777777777";
const SCOPE = "host-prompt-dedupe-test";
const at = "2026-09-24T00:00:00.000Z";
const PROMPT = "Read README.md, then run the tests";
const context: ClaudeCodeContext = {
  agent: {
    agent_key: "acme.core.claude-code",
    fleet_id: "wrk_test",
    runtime: "claude-code",
    harness: "claude-code",
    wrapper_version: "2.1.1",
  },
};

function recorder(): SessionRecorder {
  const made = new SessionRecorder({
    context,
    harnessSessionId: ID,
    scope: SCOPE,
  });
  made.ingestHook({ session_id: ID, hook_event_name: "SessionStart" }, {}, at);
  return made;
}

function submit(chain: SessionRecorder, prompt: string): void {
  chain.ingestHook(
    { session_id: ID, hook_event_name: "UserPromptSubmit", prompt },
    {},
    at,
  );
}

/** The transcript line Claude Code writes for a typed prompt. */
function transcriptPrompt(prompt: string, uuid = "msg_1"): string {
  return JSON.stringify({
    type: "user",
    timestamp: at,
    uuid,
    promptSource: "user",
    message: { role: "user", content: prompt },
  });
}

function transcriptMessages(chain: SessionRecorder) {
  return chain.sealedEvents.filter(
    (event) => event.kind === "oxagen:message" && event.source === "transcript",
  );
}

function bodiesHolding(chain: SessionRecorder, text: string): number {
  return chain
    .takeBodies()
    .filter((body) => new TextDecoder().decode(body.bytes) === text).length;
}

describe("a prompt reported by the hook and the transcript", () => {
  it("holds the text once, on the turn_start", () => {
    const chain = recorder();
    submit(chain, PROMPT);
    chain.ingestTranscriptLine(transcriptPrompt(PROMPT));

    const turnStart = chain.sealedEvents.find((e) => e.kind === "turn_start");
    expect(turnStart?.content?.digest).toMatch(/^sha256:/);
    const [copy] = transcriptMessages(chain);
    expect(copy?.content).toBeUndefined();
    expect(copy?.attrs[PROMPT_DUPLICATE_OF_ATTR]).toBe("turn_start");
    const body = copy?.body as Record<string, unknown> | undefined;
    expect(body?.["message_uuid"]).toBe("msg_1");
    expect(body?.["prompt_digest"]).toBe(
      (turnStart?.body as Record<string, unknown>)["prompt_digest"],
    );
    expect(bodiesHolding(chain, PROMPT)).toBe(1);
  });

  it("matches a copy the tailer reads after the turn closed", () => {
    const chain = recorder();
    submit(chain, PROMPT);
    chain.ingestHook({ session_id: ID, hook_event_name: "Stop" }, {}, at);
    chain.ingestTranscriptLine(transcriptPrompt(PROMPT));
    expect(transcriptMessages(chain)[0]?.content).toBeUndefined();
    expect(bodiesHolding(chain, PROMPT)).toBe(1);
  });

  it("keeps the text of a transcript record the turn never sealed", () => {
    const chain = recorder();
    submit(chain, PROMPT);
    chain.ingestTranscriptLine(transcriptPrompt("a different message"));
    const [other] = transcriptMessages(chain);
    expect(other?.content?.digest).toMatch(/^sha256:/);
    expect(other?.attrs[PROMPT_DUPLICATE_OF_ATTR]).toBeUndefined();
  });

  it("keeps the text when the transcript copy arrives before the hook", () => {
    const chain = recorder();
    chain.ingestTranscriptLine(transcriptPrompt(PROMPT));
    submit(chain, PROMPT);
    expect(transcriptMessages(chain)[0]?.content?.digest).toMatch(/^sha256:/);
    expect(bodiesHolding(chain, PROMPT)).toBe(2);
  });

  it("strips only the first copy of one prompt", () => {
    const chain = recorder();
    submit(chain, PROMPT);
    chain.ingestTranscriptLine(transcriptPrompt(PROMPT, "msg_1"));
    chain.ingestTranscriptLine(transcriptPrompt(PROMPT, "msg_2"));
    const [first, second] = transcriptMessages(chain);
    expect(first?.content).toBeUndefined();
    expect(second?.content?.digest).toMatch(/^sha256:/);
  });

  it("keeps matching the prompt a restart carried over", () => {
    const chain = recorder();
    submit(chain, PROMPT);
    const resumed = new SessionRecorder({
      context,
      harnessSessionId: ID,
      scope: SCOPE,
      restore: chain.state(),
    });
    resumed.ingestTranscriptLine(transcriptPrompt(PROMPT));
    const [copy] = transcriptMessages(resumed);
    expect(copy?.content).toBeUndefined();
    expect(copy?.attrs[PROMPT_DUPLICATE_OF_ATTR]).toBe("turn_start");
  });

  it("matches again after a rollback undid the first match", () => {
    const chain = recorder();
    submit(chain, PROMPT);
    const mark = chain.markChain();
    chain.ingestTranscriptLine(transcriptPrompt(PROMPT));
    chain.rollbackChain(mark);
    chain.ingestTranscriptLine(transcriptPrompt(PROMPT));
    const copies = transcriptMessages(chain);
    expect(copies).toHaveLength(1);
    expect(copies[0]?.content).toBeUndefined();
  });
});
