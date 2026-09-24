import {
  GENESIS_CURSOR,
  type ChainCursor,
  type TachoEvent,
  type UnsealedTachoEvent,
  digestBytes,
  sealEvent,
  sessionUuid,
} from "@oxagen/tacho";
import { describe, expect, it } from "vitest";
import {
  countContentFrames,
  sealTachoSession,
  verifyBatchBodies,
} from "./tacho-replay";
import { sealTachoSession as fromTacho } from "@oxagen/tacho";

const SESSION = sessionUuid("tch_host", "sess-1");
const OUTPUT = "hello";

function events(): TachoEvent[] {
  let cursor: ChainCursor = GENESIS_CURSOR;
  const out: TachoEvent[] = [];
  for (const draft of [
    { kind: "agent_start", body: { session_start_source: "startup" } },
    {
      kind: "tool_call",
      body: { tool_name: "Bash", tool_use_id: "t1", tool_status: "ok" },
      content: { digest: digestBytes(OUTPUT), redactions: [] },
    },
  ]) {
    const sealed = sealEvent(
      {
        v: "tacho/1.0",
        event_id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        session_id: "sess-1",
        session_uuid: SESSION,
        root_session_uuid: SESSION,
        ts: "2026-09-08T10:06:03.000Z",
        fidelity: "sdk",
        source: "hook",
        agent: {
          agent_key: "acme.core.cc",
          fleet_id: "wrk_1",
          runtime: "claude-code",
          harness: "claude-code",
          wrapper_version: "2.1.1",
        },
        ...draft,
      } as UnsealedTachoEvent,
      cursor,
    );
    cursor = sealed.next;
    out.push(sealed.event);
  }
  return out;
}

const b64 = (text: string) => Buffer.from(text).toString("base64");

describe("verifyBatchBodies", () => {
  it("accepts a body that hashes to the chained digest", () => {
    const [start, call] = events() as [TachoEvent, TachoEvent];
    const result = verifyBatchBodies(
      [start, call],
      [
        {
          event_id_idem: call.event_id_idem,
          content_type: "text/plain",
          bytes_base64: b64(OUTPUT),
        },
      ],
    );
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toMatchObject({
      eventIdIdem: call.event_id_idem,
      sessionUuid: SESSION,
      kind: "tool_call",
      digest: digestBytes(OUTPUT),
      contentType: "text/plain",
    });
  });

  it("refuses an unknown event, a frame without a digest, a mismatch and a credential", () => {
    const [start, call] = events() as [TachoEvent, TachoEvent];
    const secret = `token ghp_${"a".repeat(36)}`;
    const forged = {
      ...call,
      content: { digest: digestBytes(secret), redactions: [] },
    } as TachoEvent;
    const result = verifyBatchBodies(
      [start, forged],
      [
        {
          event_id_idem: `evt_${"0".repeat(64)}`,
          content_type: "text/plain",
          bytes_base64: b64("x"),
        },
        {
          event_id_idem: start.event_id_idem,
          content_type: "text/plain",
          bytes_base64: b64("x"),
        },
        {
          event_id_idem: forged.event_id_idem,
          content_type: "text/plain",
          bytes_base64: b64("wrong"),
        },
        {
          event_id_idem: forged.event_id_idem,
          content_type: "text/plain",
          bytes_base64: b64(secret),
        },
      ],
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((r) => r.reason)).toEqual([
      "unknown_event",
      "no_content_digest",
      "digest_mismatch",
      "credential_detected",
    ]);
  });

  it("counts a duplicate body once", () => {
    const [start, call] = events() as [TachoEvent, TachoEvent];
    const body = {
      event_id_idem: call.event_id_idem,
      content_type: "text/plain",
      bytes_base64: b64(OUTPUT),
    };
    expect(
      verifyBatchBodies([start, call], [body, body]).accepted,
    ).toHaveLength(1);
    expect(countContentFrames([start, call])).toBe(1);
  });
});

describe("countContentFrames", () => {
  it("counts a content-bearing kind with no digest as a content frame, and a digest on any kind", () => {
    const [start, call] = events() as [TachoEvent, TachoEvent];
    const bare = { ...call, content: undefined } as TachoEvent;
    expect(countContentFrames([start, bare])).toBe(1);
    const digestedStart = {
      ...start,
      content: { digest: digestBytes("x"), redactions: [] },
    } as TachoEvent;
    expect(countContentFrames([digestedStart, bare])).toBe(2);
    expect(countContentFrames([start])).toBe(0);
  });
});

// The grading moved to `@oxagen/tacho` (#3980), where its cases now live, so
// the idle close grades with the same rule. Ingest still imports it from here.
describe("sealTachoSession", () => {
  it("is the one in @oxagen/tacho", () => {
    expect(sealTachoSession).toBe(fromTacho);
  });
});
