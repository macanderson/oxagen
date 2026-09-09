import { describe, expect, it } from "vitest";
import {
  GENESIS_CURSOR,
  GENESIS_PREV_HASH,
  hashEvent,
  sealEvent,
  verifyChain,
} from "./chain";
import { digestBytes } from "./digest";
import type { TachoEvent } from "./envelope";
import { minimalSession, unsealed } from "./test-helpers";

describe("hash chain", () => {
  it("roots the genesis event in sha256 of the empty string", () => {
    expect(GENESIS_PREV_HASH).toBe(digestBytes(""));
    const { event, next } = sealEvent(
      unsealed("agent_start", {}),
      GENESIS_CURSOR,
    );
    expect(event.seq).toBe(0);
    expect(event.prev_hash).toBe(GENESIS_PREV_HASH);
    expect(event.hash).toBe(
      hashEvent(event as unknown as Record<string, unknown>),
    );
    expect(next).toEqual({ seq: 1, prevHash: event.hash });
  });

  it("verifies a sealed session end to end", () => {
    const events = minimalSession();
    const verdict = verifyChain(events);
    expect(verdict.ok).toBe(true);
    expect(verdict.violations).toEqual([]);
    expect(verdict.eventCount).toBe(events.length);
    expect(verdict.finalHash).toBe(events[events.length - 1]?.hash);
  });

  it("detects a tampered body, a broken link, a gap, and a foreign event", () => {
    const events = minimalSession();
    const tampered = structuredClone(events) as TachoEvent[];
    const third = tampered[2] as TachoEvent & {
      body: { input_tokens?: number };
    };
    third.body.input_tokens = 999;
    expect(verifyChain(tampered).violations).toContain(
      "seq 2 hash does not match its content",
    );

    const gapped = events.filter((event) => event.seq !== 3);
    const gapVerdict = verifyChain(gapped);
    expect(gapVerdict.ok).toBe(false);
    expect(gapVerdict.violations.some((v) => v.includes("must be dense"))).toBe(
      true,
    );
    expect(
      gapVerdict.violations.some((v) => v.includes("prev_hash does not match")),
    ).toBe(true);

    const foreign = structuredClone(events) as TachoEvent[];
    (foreign[1] as TachoEvent).session_uuid =
      "00000000-0000-4000-8000-000000000000";
    expect(
      verifyChain(foreign).violations.some((v) =>
        v.includes("belongs to session"),
      ),
    ).toBe(true);
  });

  it("treats an empty slice as unverifiable and a partial slice as allowed when asked", () => {
    expect(verifyChain([])).toMatchObject({
      ok: false,
      violations: ["no events"],
    });
    const tail = minimalSession().slice(2);
    expect(verifyChain(tail).violations).toContain(
      "chain opens at seq 2, not 0",
    );
    expect(verifyChain(tail, { expectGenesis: false }).ok).toBe(true);
  });
});
