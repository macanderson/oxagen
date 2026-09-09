import { describe, expect, it } from "vitest";
import { GENESIS_CURSOR, sealEvent } from "./chain";
import {
  BODY_MEMBER_NAMES,
  KIND_BODIES,
  TACHO_KINDS,
  isTachoKind,
  parseTachoEvent,
  tachoEventSchema,
} from "./envelope";
import { unsealed } from "./test-helpers";

describe("tacho/1.0 envelope", () => {
  it("parses a minimal event of every kind", () => {
    for (const kind of TACHO_KINDS) {
      const { event } = sealEvent(unsealed(kind, {}), GENESIS_CURSOR);
      expect(event.kind).toBe(kind);
      expect(tachoEventSchema.safeParse(event).success).toBe(true);
    }
    expect(TACHO_KINDS.length).toBeGreaterThanOrEqual(45);
  });

  it("refuses an unknown body member so producer drift is visible", () => {
    const { event } = sealEvent(
      unsealed("tool_call", { tool_name: "Read" }),
      GENESIS_CURSOR,
    );
    const drifted = { ...event, body: { ...event.body, tool_nmae: "Read" } };
    expect(() => parseTachoEvent(drifted)).toThrow();
  });

  it("refuses a body member that belongs to another kind", () => {
    const { event } = sealEvent(unsealed("checkpoint", {}), GENESIS_CURSOR);
    const wrong = { ...event, body: { tool_name: "Read" } };
    expect(tachoEventSchema.safeParse(wrong).success).toBe(false);
  });

  it("refuses a hash that does not match the digest pattern and an off-profile timestamp", () => {
    const { event } = sealEvent(unsealed("agent_start", {}), GENESIS_CURSOR);
    expect(
      tachoEventSchema.safeParse({ ...event, hash: "sha256:nope" }).success,
    ).toBe(false);
    expect(
      tachoEventSchema.safeParse({ ...event, ts: "2026-09-08 10:06:03" })
        .success,
    ).toBe(false);
  });

  it("names every body member exactly once across the fact groups", () => {
    expect(new Set(BODY_MEMBER_NAMES).size).toBe(BODY_MEMBER_NAMES.length);
    for (const kind of TACHO_KINDS) {
      for (const member of Object.keys(KIND_BODIES[kind].shape)) {
        expect(BODY_MEMBER_NAMES).toContain(member);
      }
    }
  });

  it("keeps the vendor namespace on harness-specific kinds", () => {
    for (const kind of TACHO_KINDS) {
      if (kind.includes(":")) {
        expect(kind.startsWith("oxagen:")).toBe(true);
      }
    }
    expect(isTachoKind("oxagen:compaction")).toBe(true);
    expect(isTachoKind("compaction")).toBe(false);
    expect(isTachoKind("__proto__")).toBe(false);
  });
});
