import { TACHO_IDLE_CLOSE_AFTER_MS } from "@oxagen/database/schema";
import { describe, expect, it } from "vitest";
import {
  idleCloseColumns,
  idleCutoff,
  type IdleSession,
} from "./tacho-idle-close";

const NOW = new Date("2026-09-24T12:00:00.000Z");
const LAST_EVENT = new Date("2026-09-23T20:00:00.000Z");
const HEAD = `sha256:${"a".repeat(64)}`;

function idle(over: Partial<IdleSession> = {}): IdleSession {
  return {
    id: "0192d4a8-7c1e-7a00-8000-0000000000c1",
    publicId: "tse_0000000000000000000001",
    orgId: "0192d4a8-7c1e-7a00-8000-0000000000a1",
    workspaceId: "0192d4a8-7c1e-7a00-8000-0000000000a2",
    parentSessionUuid: null,
    seqCount: 12,
    lastHash: HEAD,
    lastEventAt: LAST_EVENT,
    chainVerified: true,
    telemetryGapCount: 0,
    contentFrames: 4,
    bodyFrames: 4,
    numToolCalls: 2,
    toolBodyFrames: 2,
    enforcementTier: "harness",
    ...over,
  };
}

describe("the idle close (#3980)", () => {
  it("closes a run that has been silent for twelve hours", () => {
    expect(TACHO_IDLE_CLOSE_AFTER_MS).toBe(12 * 60 * 60 * 1000);
    expect(idleCutoff(NOW)).toEqual(new Date("2026-09-24T00:00:00.000Z"));
  });

  it("records the close as the control plane's, with an unknown outcome and an unobserved tail", () => {
    expect(idleCloseColumns(idle(), "content_exact", NOW)).toEqual({
      sealedAt: NOW,
      sealSource: "idle_timeout",
      outcome: "unknown",
      // The end is the last event received, not the moment the silence was noticed.
      endedAt: LAST_EVENT,
      finalHash: HEAD,
      unobservedTail: true,
      completenessGaps: ["unobserved_tail"],
      // An unobserved tail leaves a reader the chain and nothing to read through.
      replayGrade: "inspect",
      updatedAt: NOW,
    });
  });

  it("keeps every gap the session's own counters show", () => {
    const closed = idleCloseColumns(
      idle({
        chainVerified: false,
        telemetryGapCount: 3,
        bodyFrames: 1,
        toolBodyFrames: 0,
      }),
      "content_exact",
      NOW,
    );
    expect(closed.completenessGaps).toEqual([
      "chain_break",
      "unobserved_tail",
      "telemetry_gap",
      "body_missing",
      "tool_bodies",
    ]);
    expect(closed.replayGrade).toBe("inspect");
  });

  it("grades a digest_only workspace by its policy, not by missing bodies", () => {
    const closed = idleCloseColumns(
      idle({ bodyFrames: 0, toolBodyFrames: 0, numToolCalls: 0 }),
      "digest_only",
      NOW,
    );
    expect(closed.completenessGaps).toEqual(["unobserved_tail", "digest_only"]);
  });
});
