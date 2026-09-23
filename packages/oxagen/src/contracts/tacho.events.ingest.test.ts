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

function genesisDraft() {
  return {
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
}

function sealedGenesis() {
  return sealEvent(genesisDraft(), GENESIS_CURSOR).event;
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
        body_rejections: [],
        control: {
          host_status: "active",
          deny_generation: { org: 1, workspace: 1 },
          bundle_etag: "etag",
          commands: [],
        },
      }).accepted,
    ).toBe(1);
    // A refused proof verdict is named beside the accepted frames.
    expect(
      tachoEventsIngest.output.safeParse({
        accepted: 1,
        event_ids: [sealedGenesis().event_id_idem],
        chain_breaks: [],
        body_rejections: [],
        proof_rejections: [
          {
            event_id_idem: sealedGenesis().event_id_idem,
            reason: "proof_body_invalid: verdict",
          },
        ],
        control: {
          host_status: "active",
          deny_generation: { org: 1, workspace: 1 },
          bundle_etag: "etag",
          commands: [],
        },
      }).success,
    ).toBe(true);
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
        body_rejections: [],
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

describe("frame bodies in a batch", () => {
  it("accepts a body naming an event in the batch and refuses a malformed one", () => {
    const genesis = sealedGenesis();
    const withBody = {
      ...validBatch(),
      bodies: [
        {
          event_id_idem: genesis.event_id_idem,
          content_type: "application/json",
          bytes_base64: Buffer.from('{"prompt":"x"}').toString("base64"),
        },
      ],
    };
    expect(tachoEventsIngest.input.safeParse(withBody).success).toBe(true);
    expect(
      tachoEventsIngest.input.safeParse({
        ...withBody,
        bodies: [{ ...withBody.bodies[0], bytes_base64: "not base64!" }],
      }).success,
    ).toBe(false);
    expect(
      tachoEventsIngest.input.safeParse({
        ...withBody,
        bodies: [{ ...withBody.bodies[0], event_id_idem: "evt_1" }],
      }).success,
    ).toBe(false);
  });

  it("reports rejected bodies with a closed reason set", () => {
    const genesis = sealedGenesis();
    const base = {
      accepted: 1,
      event_ids: [genesis.event_id_idem],
      chain_breaks: [],
      control: {
        host_status: "active",
        deny_generation: { org: 1, workspace: 1 },
        bundle_etag: "etag",
        commands: [],
      },
    };
    expect(
      tachoEventsIngest.output.safeParse({
        ...base,
        body_rejections: [
          { event_id_idem: genesis.event_id_idem, reason: "digest_mismatch" },
        ],
      }).success,
    ).toBe(true);
    expect(
      tachoEventsIngest.output.safeParse({
        ...base,
        body_rejections: [
          { event_id_idem: genesis.event_id_idem, reason: "too_big" },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("proof.observed frames in a batch (ADR-064)", () => {
  const d = (c: string) => `sha256:${c.repeat(64)}`;
  const flip = {
    witness_id: "wit_01K5RQ8M4",
    oracle: "test_flip",
    target_ref: "main",
    target_sha: "a4c91e2",
    pr_ref: "refs/pull/482/head",
    pr_sha: "f70b3d9",
    command_normalized_digest: d("1"),
    target_result: "fail",
    pr_result: "pass",
    verdict: "flipped",
    fail_fingerprint: d("2"),
    pass_output_digest: d("3"),
    tamper_exclusion: "held",
    disclosure_grain: "L0",
    witness_run_id: null,
    runner_attestation: { key_id: "kms:witness/v3", signature: "MEUCIQ" },
  };

  function batchWithProof(body: Record<string, unknown>) {
    const { event: genesis, next } = sealEvent(genesisDraft(), GENESIS_CURSOR);
    const proof = sealEvent(
      {
        v: "tacho/1.0",
        event_id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAW",
        session_id: "sess-1",
        session_uuid: SESSION,
        root_session_uuid: SESSION,
        ts: "2026-09-08T10:07:03.000Z",
        fidelity: "sdk",
        source: "hook",
        agent: genesis.agent,
        kind: "proof.observed",
        body,
      } satisfies UnsealedTachoEvent,
      next,
    ).event;
    return { ...validBatch(), events: [genesis, proof] };
  }

  it("accepts a proof body that holds to the run-evidence schema", () => {
    const parsed = tachoEventsIngest.input.parse(batchWithProof(flip));
    expect(parsed.events[1]?.kind).toBe("proof.observed");
  });

  it("does not refuse the batch for a malformed proof body: the handler skips only its verdict", () => {
    // Refusing the whole batch here made the host quarantine it, and the next
    // batch then failed the dense-seq check for good. The frame is a link in
    // the chain; the handler records it and names the refused verdict in
    // `proof_rejections`.
    const flipWithoutFlip = tachoEventsIngest.input.safeParse(
      batchWithProof({ ...flip, target_result: "pass" }),
    );
    expect(flipWithoutFlip.success).toBe(true);
    expect(
      tachoEventsIngest.input.safeParse(
        batchWithProof({ ...flip, test_name: "notes.contract.test.ts" }),
      ).success,
    ).toBe(true);
  });
});
