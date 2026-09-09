/** Builders shared by the package tests. Not part of the public surface. */
import { type ChainCursor, GENESIS_CURSOR, sealEvent } from "./chain";
import { newEventId, sessionUuid } from "./ids";
import type {
  BodyOf,
  TachoEvent,
  TachoKind,
  UnsealedTachoEvent,
} from "./envelope";

export const TEST_HOST = "thst_0123456789abcdef0123";
export const TEST_SESSION_ID = "340ed354-6344-4727-9f8b-1e40b5e12aa7";
export const TEST_SESSION_UUID = sessionUuid(TEST_HOST, TEST_SESSION_ID);

export function unsealed<K extends TachoKind>(
  kind: K,
  body: BodyOf<K>,
  overrides: Partial<Omit<UnsealedTachoEvent, "kind" | "body">> = {},
): UnsealedTachoEvent {
  return {
    v: "tacho/1.0",
    event_id: newEventId(1_788_861_900_000),
    session_id: TEST_SESSION_ID,
    session_uuid: TEST_SESSION_UUID,
    root_session_uuid: TEST_SESSION_UUID,
    ts: "2026-09-08T10:06:03.000Z",
    fidelity: "sdk",
    source: "hook",
    agent: {
      agent_key: "acme.core.cc-laptop",
      fleet_id: "wrk_test",
      runtime: "claude-code",
      harness: "claude-code",
      harness_version: "2.1.263",
      wrapper_version: "2.1.1",
      host_enrollment_id: TEST_HOST,
    },
    ...overrides,
    kind,
    body,
  } as UnsealedTachoEvent;
}

/** Seal a list of unsealed events into a valid chain. */
export function sealAll(events: UnsealedTachoEvent[]): TachoEvent[] {
  let cursor: ChainCursor = GENESIS_CURSOR;
  return events.map((event) => {
    const sealed = sealEvent(event, cursor);
    cursor = sealed.next;
    return sealed.event;
  });
}

/** A minimal, valid session: start, one turn with one tool, stop. */
export function minimalSession(): TachoEvent[] {
  return sealAll([
    unsealed("agent_start", {
      model: "claude-haiku-4-5-20251001",
      session_start_source: "startup",
    }),
    unsealed(
      "turn_start",
      { prompt_length: 12 },
      { turn: { turn_seq: 1, prompt_id: "p1" } },
    ),
    unsealed(
      "llm_call",
      {
        model: "claude-haiku-4-5-20251001",
        input_tokens: 10,
        output_tokens: 5,
        context_window: 200_000,
      },
      { source: "otel_log", turn: { turn_seq: 1, prompt_id: "p1" } },
    ),
    unsealed(
      "tool_requested",
      { tool_name: "Read", tool_use_id: "toolu_1", policy_decision: "allow" },
      { turn: { turn_seq: 1, prompt_id: "p1" } },
    ),
    unsealed(
      "tool_call",
      {
        tool_name: "Read",
        tool_use_id: "toolu_1",
        tool_status: "ok",
        tool_duration_ms: 2,
      },
      { turn: { turn_seq: 1, prompt_id: "p1" } },
    ),
    unsealed(
      "llm_call",
      {
        model: "claude-haiku-4-5-20251001",
        input_tokens: 10,
        output_tokens: 5,
        context_window: 200_000,
      },
      { source: "otel_log", turn: { turn_seq: 1, prompt_id: "p1" } },
    ),
    unsealed(
      "turn_end",
      { last_assistant_message_digest: `sha256:${"a".repeat(64)}` },
      { turn: { turn_seq: 1, prompt_id: "p1" } },
    ),
    unsealed("agent_stop", {
      session_outcome: "completed",
      session_end_reason: "other",
    }),
  ]);
}
