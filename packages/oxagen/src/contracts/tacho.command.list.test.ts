import { describe, expect, it } from "vitest";
import { tachoCommandList } from "./tacho.command.list";

const RUN = "tse_0123456789abcdefghjkmn";

const item = {
  id: "tcm_1",
  runId: RUN,
  agentKey: null,
  command: "steer",
  status: "applied",
  requestedMode: "interrupt",
  deliveryMode: "next_step",
  degradedReason: "harness_tier",
  reason: null,
  issuedAt: "2026-09-08T10:00:00.000Z",
  expiresAt: "2026-09-08T11:00:00.000Z",
  sentAt: "2026-09-08T10:00:05.000Z",
  acknowledgedAt: "2026-09-08T10:00:09.000Z",
  appliedAt: "2026-09-08T10:00:09.000Z",
  appliedAtSeq: 41,
  detail: null,
  issuedBy: { id: "usr_0123456789abcdefghjkmn", name: "Ada Park" },
  text: "Run the migration tests before you push.",
};

describe("list_commands contract", () => {
  it("is a console read: mutates false, noBillingGate true", () => {
    expect(tachoCommandList.name).toBe("list_commands");
    expect(tachoCommandList.mutates).toBe(false);
    expect(tachoCommandList.noBillingGate).toBe(true);
    expect(tachoCommandList.scoped).toBe(true);
    expect(tachoCommandList.layers).not.toContain("e2e");
  });

  it("defaults and bounds the limit, and refuses an id neither store mints (negative)", () => {
    expect(tachoCommandList.input.parse({ runId: RUN })).toEqual({
      runId: RUN,
      limit: 50,
    });
    expect(
      tachoCommandList.input.safeParse({ runId: RUN, limit: 0 }).success,
    ).toBe(false);
    expect(
      tachoCommandList.input.safeParse({ runId: RUN, limit: 101 }).success,
    ).toBe(false);
    expect(tachoCommandList.input.safeParse({ runId: "sess-1" }).success).toBe(
      false,
    );
  });

  it("carries the requested and the achieved mode separately, and the frame an applied command landed on", () => {
    const parsed = tachoCommandList.output.parse({ commands: [item] });
    expect(parsed.commands[0]).toMatchObject({
      requestedMode: "interrupt",
      deliveryMode: "next_step",
      degradedReason: "harness_tier",
      appliedAtSeq: 41,
    });
  });

  it("refuses a status outside the §7.4 vocabulary and a missing mode field (negative)", () => {
    expect(
      tachoCommandList.output.safeParse({
        commands: [{ ...item, status: "pending" }],
      }).success,
    ).toBe(false);
    const { deliveryMode: _dropped, ...withoutMode } = item;
    expect(
      tachoCommandList.output.safeParse({ commands: [withoutMode] }).success,
    ).toBe(false);
  });

  it("carries a steer held for an idle agent's next run with the agent in place of the run", () => {
    const held = {
      ...item,
      runId: null,
      agentKey: "acme.core.reviewer",
      status: "queued",
      deliveryMode: null,
      degradedReason: null,
      sentAt: null,
      acknowledgedAt: null,
      appliedAt: null,
      appliedAtSeq: null,
    };
    expect(
      tachoCommandList.output.safeParse({ commands: [held] }).success,
    ).toBe(true);
    // Every row says which it is waiting on: a run or an agent (negative).
    const { agentKey: _missing, ...withoutAgent } = held;
    expect(
      tachoCommandList.output.safeParse({ commands: [withoutAgent] }).success,
    ).toBe(false);
  });
});
