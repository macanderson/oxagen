import { describe, expect, it } from "vitest";
import {
  FRAME_LIMIT_DEFAULT,
  FRAME_LIMIT_MAX,
  runGet,
  WAIT_MS_MAX,
} from "./run.get";

const LEDGER_ID = "arun_5f0c2e9a1b7d4c3e8f6a02";

describe("get_run contract", () => {
  it("is a console read an SSE poll may make: mutates false, noBillingGate true", () => {
    expect(runGet.mutates).toBe(false);
    expect(runGet.noBillingGate).toBe(true);
    expect(runGet.scoped).toBe(true);
    expect(runGet.defaultEffect).toBe("deny");
    expect(runGet.layers).not.toContain("e2e");
  });

  it("defaults the frame page and the wait, and bounds both", () => {
    expect(runGet.input.parse({ runId: LEDGER_ID })).toEqual({
      runId: LEDGER_ID,
      frameLimit: FRAME_LIMIT_DEFAULT,
      waitMs: 0,
    });
    expect(
      runGet.input.safeParse({ runId: LEDGER_ID, frameLimit: 0 }).success,
    ).toBe(false);
    expect(
      runGet.input.safeParse({
        runId: LEDGER_ID,
        frameLimit: FRAME_LIMIT_MAX + 1,
      }).success,
    ).toBe(false);
    expect(
      runGet.input.safeParse({ runId: LEDGER_ID, waitMs: WAIT_MS_MAX + 1 })
        .success,
    ).toBe(false);
    expect(
      runGet.input.safeParse({ runId: LEDGER_ID, waitMs: -1 }).success,
    ).toBe(false);
  });

  it("refuses an id neither store mints (negative)", () => {
    expect(runGet.input.safeParse({ runId: "aex_123" }).success).toBe(false);
    expect(runGet.input.safeParse({ runId: "arun_ABC" }).success).toBe(false);
  });

  it("answers frames as a page or null, never a bare array", () => {
    const run = {
      id: LEDGER_ID,
      source: "ledger",
      agentKey: null,
      operatorId: "prn_0123456789abcdefghjkmn",
      status: "live",
      turns: null,
      steps: 0,
      frames: 0,
      cost: null,
      taskRef: "fix the flaky test",
      startedAt: "2026-09-08T10:06:03.000Z",
      sealedAt: null,
    };
    expect(runGet.output.safeParse({ run, frames: null }).success).toBe(true);
    expect(
      runGet.output.safeParse({ run, frames: { frames: [], cursor: null } })
        .success,
    ).toBe(true);
    expect(runGet.output.safeParse({ run, frames: [] }).success).toBe(false);
  });
});
