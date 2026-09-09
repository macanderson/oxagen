import {
  GENESIS_CURSOR,
  type UnsealedTachoEvent,
  sealEvent,
  sessionUuid,
} from "@oxagen/tacho";
import { describe, expect, it } from "vitest";
import { tachoEventsIngest } from "./tacho.events.ingest";

const HOST = "tch_0123456789abcdefghjkmn";
const SESSION = sessionUuid(HOST, "sess-1");

function sealedGenesis() {
  const unsealed = {
    v: "tacho/1.0",
    event_id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    session_id: "sess-1",
    session_uuid: SESSION,
    root_session_uuid: SESSION,
    ts: "2026-09-08T10:06:03.000Z",
    fidelity: "sdk",
    source: "hook",
    agent: {
      agent_key: "acme.core.cc-laptop",
      fleet_id: "wrk_1",
      runtime: "claude-code",
      harness: "claude-code",
      wrapper_version: "2.1.1",
      host_enrollment_id: HOST,
    },
    kind: "agent_start",
    body: { session_start_source: "startup" },
  } satisfies UnsealedTachoEvent;
  return sealEvent(unsealed, GENESIS_CURSOR).event;
}

function validBatch() {
  return {
    schema: "tacho.batch.v1",
    host_enrollment_id: HOST,
    events: [sealedGenesis()],
    daemon: { version: "2.1.1", spool_depth: 0, hooks_ok: true, otel_ok: true },
  };
}

describe("tachoEventsIngest", () => {
  it("accepts a sealed tacho/1.0 batch and a well-formed control envelope", () => {
    const parsed = tachoEventsIngest.input.parse(validBatch());
    expect(parsed.events[0]?.kind).toBe("agent_start");
    expect(
      tachoEventsIngest.output.parse({
        accepted: 1,
        event_ids: [sealedGenesis().event_id_idem],
        chain_breaks: [],
        control: {
          host_status: "active",
          deny_generation: { org: 1, workspace: 1 },
          bundle_etag: "etag",
          commands: [],
        },
      }).accepted,
    ).toBe(1);
  });

  it("rejects unknown batch members, a body with prompt bytes, and a mismatched count", () => {
    expect(
      tachoEventsIngest.input.safeParse({ ...validBatch(), prompt: "x" })
        .success,
    ).toBe(false);
    const withPrompt = validBatch();
    (withPrompt.events[0] as unknown as { body: Record<string, unknown> }).body[
      "prompt"
    ] = "secret";
    expect(tachoEventsIngest.input.safeParse(withPrompt).success).toBe(false);
    expect(
      tachoEventsIngest.output.safeParse({
        accepted: 2,
        event_ids: [sealedGenesis().event_id_idem],
        chain_breaks: [],
        control: {
          host_status: "active",
          deny_generation: { org: 1, workspace: 1 },
          bundle_etag: "e",
          commands: [],
        },
      }).success,
    ).toBe(false);
  });

  it("is an API-only, high-sensitivity, default-deny, unbilled capability", () => {
    expect(tachoEventsIngest.name).toBe("ingest_tacho_events");
    expect(tachoEventsIngest.surfaces).toEqual(["api"]);
    expect(tachoEventsIngest.sensitivity).toBe("high");
    expect(tachoEventsIngest.defaultEffect).toBe("deny");
    expect(tachoEventsIngest.noBillingGate).toBe(true);
  });
});
