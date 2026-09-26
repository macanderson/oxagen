import {
  GENESIS_CURSOR,
  type ChainCursor,
  LLM_CALL_DUPLICATE_OF_ATTR,
  RESPONSE_BODY_OMITTED_ATTR,
  type TachoEvent,
  type UnsealedTachoEvent,
  digestBytes,
  sealEvent,
  sessionUuid,
} from "@oxagen/tacho";
import { describe, expect, it } from "vitest";
import {
  countBodyFrames,
  countContentFrames,
  sealTachoSession,
  verifyBatchBodies,
} from "./tacho-replay";
import { sealTachoSession as fromTacho } from "@oxagen/tacho";

const SESSION = sessionUuid("tch_host", "sess-1");
const OUTPUT = "hello";

function events(): TachoEvent[] {
  return chain([
    { kind: "agent_start", body: { session_start_source: "startup" } },
    {
      kind: "tool_call",
      body: { tool_name: "Bash", tool_use_id: "t1", tool_status: "ok" },
      content: { digest: digestBytes(OUTPUT), redactions: [] },
    },
  ]);
}

/** Seal drafts onto one chain, in order. */
function chain(drafts: readonly Record<string, unknown>[]): TachoEvent[] {
  let cursor: ChainCursor = GENESIS_CURSOR;
  const out: TachoEvent[] = [];
  for (const draft of drafts) {
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

describe("a half-captured model call", () => {
  // The proxy keeps the request half when the response is past the size cap,
  // and says so on the frame. The body counted as a whole capture, so the
  // session sealed `view` while the reader could not see the answer (#3372,
  // finding 5).
  const REQUEST_ONLY = '{"request":"{\\"model\\":\\"claude-sonnet-5\\"}"}';

  function halfCaptured(): TachoEvent[] {
    return chain([
      { kind: "agent_start", body: { session_start_source: "startup" } },
      {
        kind: "llm_call",
        source: "collector",
        body: { provider: "anthropic", model: "claude-sonnet-5" },
        content: { digest: digestBytes(REQUEST_ONLY), redactions: [] },
        attrs: { [RESPONSE_BODY_OMITTED_ATTR]: "too_large" },
      },
    ]);
  }

  it("accepts the half body and marks it partial", () => {
    const [start, call] = halfCaptured() as [TachoEvent, TachoEvent];
    const { accepted, rejected } = verifyBatchBodies(
      [start, call],
      [
        {
          event_id_idem: call.event_id_idem,
          content_type: "application/json",
          bytes_base64: b64(REQUEST_ONLY),
        },
      ],
    );
    expect(rejected).toEqual([]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.partial).toBe(true);
    expect(countBodyFrames(accepted)).toEqual({
      bodyFrames: 0,
      toolBodyFrames: 0,
    });
  });

  it("seals body_missing and grades inspect, the way ingest counts it", () => {
    const batch = halfCaptured();
    const call = batch[1]!;
    const { accepted } = verifyBatchBodies(batch, [
      {
        event_id_idem: call.event_id_idem,
        content_type: "application/json",
        bytes_base64: b64(REQUEST_ONLY),
      },
    ]);
    const seal = sealTachoSession({
      hostGaps: [],
      chainVerified: true,
      unobservedTail: false,
      telemetryGapCount: 0,
      retentionMode: "content_exact",
      contentFrames: countContentFrames(batch),
      ...countBodyFrames(accepted),
      toolCalls: 0,
      enforcementTier: "gateway",
    });
    expect(seal).toEqual({
      completenessGaps: ["body_missing"],
      replayGrade: "inspect",
    });
  });

  it("counts a whole body, and a tool result body, as before", () => {
    const [start, call] = events() as [TachoEvent, TachoEvent];
    const { accepted } = verifyBatchBodies(
      [start, call],
      [
        {
          event_id_idem: call.event_id_idem,
          content_type: "text/plain",
          bytes_base64: b64(OUTPUT),
        },
      ],
    );
    expect(accepted[0]!.partial).toBe(false);
    expect(countBodyFrames(accepted)).toEqual({
      bodyFrames: 1,
      toolBodyFrames: 1,
    });
  });
});

describe("countContentFrames", () => {
  it("counts a model call once when the OTel exporter reports it after the proxy", () => {
    // The proxy seals the call with its body. The OTel exporter's copy is
    // sealed later, stamped as a duplicate, with no bytes. Counting the copy
    // left every proxied session one body short per call, so it sealed
    // `body_missing` and graded `inspect` however much the proxy captured.
    const EXCHANGE = '{"request":"{}","response":"{}"}';
    const batch = chain([
      { kind: "agent_start", body: { session_start_source: "startup" } },
      {
        kind: "llm_call",
        source: "collector",
        body: { provider: "anthropic", model: "claude-sonnet-5" },
        content: { digest: digestBytes(EXCHANGE), redactions: [] },
      },
      {
        kind: "llm_call",
        source: "otel_log",
        body: { provider: "anthropic", model: "claude-sonnet-5" },
        attrs: { [LLM_CALL_DUPLICATE_OF_ATTR]: "collector" },
      },
    ]);
    expect(countContentFrames(batch)).toBe(1);
    // A first sighting with no bytes still owes its body.
    const otelOnly = chain([
      {
        kind: "llm_call",
        source: "otel_log",
        body: { provider: "anthropic", model: "claude-sonnet-5" },
      },
    ]);
    expect(countContentFrames(otelOnly)).toBe(1);
  });

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
