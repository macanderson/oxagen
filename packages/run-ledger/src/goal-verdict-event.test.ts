/**
 * `verification.goal_verdict`: one round's verdict from the engine's goal
 * verifier, as the in-app agent's recorder writes it (ADR-XXX). The payload
 * is receipt metadata only; the goal and the reasoning ride the frame's body.
 */
import { describe, expect, it } from "vitest";
import {
  EVENT_TYPE_REGISTRY,
  retentionContentClassOf,
  stageOfEventType,
  stepKindOfEventType,
  validateInlineEventPayload,
} from "./event-payload-registry";
import { NO_BODY } from "./frame-body";
import { RunSpecValidationError } from "./run-errors";
import { ledgerFrame } from "./run-frames";
import type { AttemptEventReadRecord } from "./run-store";

const TYPE = "verification.goal_verdict";
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

function payload(over: Record<string, unknown> = {}) {
  return {
    engine_seq: 12,
    round: 1,
    met: true,
    goal_digest: DIGEST_A,
    reasoning_digest: DIGEST_B,
    verifier_cost_usd_micros: 2100,
    ...over,
  };
}

function event(p: Record<string, unknown>): AttemptEventReadRecord {
  return {
    eventId: "e1",
    attemptId: "a1",
    attemptPublicId: "arat_1",
    runSeq: "7",
    attemptSeq: 7,
    eventSchemaVersion: "1",
    eventType: TYPE,
    stage: "verification",
    payloadDigest: DIGEST_A,
    eventDigest: DIGEST_B,
    payload: p,
    encryptedPayloadRef: null,
    observedAt: new Date("2026-09-25T10:00:00.000Z"),
    recordedAt: new Date("2026-09-25T10:00:01.000Z"),
    body: NO_BODY,
  };
}

describe("verification.goal_verdict", () => {
  it("is a verification receipt that completes no step", () => {
    expect(Object.hasOwn(EVENT_TYPE_REGISTRY, TYPE)).toBe(true);
    expect(stageOfEventType(TYPE)).toBe("verification");
    expect(retentionContentClassOf(TYPE)).toBe("verification_receipt");
    // A verdict is not a model or tool call of the turn, so it never counts
    // toward a run's steps.
    expect(stepKindOfEventType(TYPE)).toBeNull();
  });

  it("accepts a met and an unmet round", () => {
    expect(validateInlineEventPayload(TYPE, payload()).eventType).toBe(TYPE);
    expect(
      validateInlineEventPayload(TYPE, payload({ round: 3, met: false })).stage,
    ).toBe("verification");
  });

  it("refuses the reasoning inline, a round of zero and a float cost (negative)", () => {
    expect(() =>
      validateInlineEventPayload(TYPE, payload({ reasoning: "because" })),
    ).toThrow(RunSpecValidationError);
    expect(() =>
      validateInlineEventPayload(TYPE, payload({ round: 0 })),
    ).toThrow(RunSpecValidationError);
    expect(() =>
      validateInlineEventPayload(
        TYPE,
        payload({ verifier_cost_usd_micros: 0.5 }),
      ),
    ).toThrow(RunSpecValidationError);
  });

  it("reads on the transcript as the round and its verdict", () => {
    const met = ledgerFrame(event(payload()));
    expect(met.summary).toBe("round 1 met");
    expect(met.identity.verdict).toBe("met");
    const unmet = ledgerFrame(event(payload({ round: 2, met: false })));
    expect(unmet.summary).toBe("round 2 not_met");
    expect(unmet.identity.verdict).toBe("not_met");
  });

  it("falls back to its type when the payload names no verdict (negative)", () => {
    const frame = ledgerFrame(event({ round: 1 }));
    expect(frame.summary).toBe(TYPE);
    expect(frame.identity.verdict).toBeNull();
  });
});
