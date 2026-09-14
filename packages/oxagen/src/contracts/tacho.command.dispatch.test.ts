import { describe, expect, it } from "vitest";
import {
  PROMPT_COMMANDS,
  STEER_TEXT_MAX,
  tachoCommandDispatch,
} from "./tacho.command.dispatch";

const RUN = "tse_0123456789abcdefghjkmn";
const WORKSPACE = "00000000-0000-4000-8000-000000000002";

describe("dispatch_command contract", () => {
  it("is the Appendix E name, a write, never refused for lack of GAUs, and org Owner/Admin only", () => {
    expect(tachoCommandDispatch.name).toBe("dispatch_command");
    expect(tachoCommandDispatch.mutates).toBe(true);
    expect(tachoCommandDispatch.noBillingGate).toBe(true);
    expect(tachoCommandDispatch.scoped).toBe(true);
    expect(tachoCommandDispatch.defaultEffect).toBe("deny");
    expect(tachoCommandDispatch.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(tachoCommandDispatch.agent).toEqual({
      requiresApproval: false,
      riskLevel: "medium",
      category: "control",
    });
    expect(tachoCommandDispatch.layers).not.toContain("e2e");
  });

  it("defaults the expiry to one hour and the requested mode to next_step", () => {
    const parsed = tachoCommandDispatch.input.parse({
      target: { kind: "run", id: RUN },
      command: "steer",
      payload: { text: "stop touching prod" },
    });
    expect(parsed.expiresInMs).toBe(3_600_000);
    expect(parsed.payload).toEqual({
      text: "stop touching prod",
      requestedMode: "next_step",
    });
  });

  it("accepts every target kind", () => {
    for (const target of [
      { kind: "run", id: RUN },
      { kind: "run", id: "arun_5f0c2e9a1b7d4c3e8f6a02" },
      { kind: "agent", id: "acme.core.cc-laptop" },
      { kind: "workspace", id: WORKSPACE },
    ]) {
      expect(
        tachoCommandDispatch.input.safeParse({
          target,
          command: "pause",
          reason: "budget review",
        }).success,
      ).toBe(true);
    }
  });

  it("requires text on steer and message and refuses a payload on the boundary commands (negative)", () => {
    for (const command of PROMPT_COMMANDS) {
      const missing = tachoCommandDispatch.input.safeParse({
        target: { kind: "run", id: RUN },
        command,
      });
      expect(missing.success).toBe(false);
      expect(missing.success ? [] : missing.error.issues[0]?.path).toEqual([
        "payload",
      ]);
    }
    for (const command of ["pause", "resume", "cancel"]) {
      const extra = tachoCommandDispatch.input.safeParse({
        target: { kind: "run", id: RUN },
        command,
        payload: { text: "x" },
      });
      expect(extra.success).toBe(false);
      expect(extra.success ? [] : extra.error.issues[0]?.path).toEqual([
        "payload",
      ]);
    }
  });

  it("refuses an unknown command, a bad target, an unknown mode, over-long text and an out-of-range expiry (negative)", () => {
    const refuse = (input: unknown) =>
      expect(tachoCommandDispatch.input.safeParse(input).success).toBe(false);
    refuse({ target: { kind: "run", id: RUN }, command: "kill" });
    refuse({ target: { kind: "run", id: RUN }, command: "revoke" });
    refuse({ target: { kind: "run", id: "sess-1" }, command: "pause" });
    refuse({ target: { kind: "host", id: "tch_x" }, command: "pause" });
    refuse({ target: { kind: "workspace", id: "core" }, command: "pause" });
    refuse({
      target: { kind: "run", id: RUN },
      command: "steer",
      payload: { text: "x", requestedMode: "now" },
    });
    refuse({
      target: { kind: "run", id: RUN },
      command: "steer",
      payload: { text: "x".repeat(STEER_TEXT_MAX + 1) },
    });
    refuse({
      target: { kind: "run", id: RUN },
      command: "pause",
      expiresInMs: 5_000,
    });
    refuse({
      target: { kind: "run", id: RUN },
      command: "pause",
      expiresInMs: 86_400_001,
    });
    refuse({ target: { kind: "run", id: RUN }, command: "pause", extra: 1 });
  });

  it("answers one id per recipient, and an empty list for a broadcast that reached nobody", () => {
    expect(
      tachoCommandDispatch.output.parse({ commandIds: ["tcm_a", "tcm_b"] })
        .commandIds,
    ).toHaveLength(2);
    expect(
      tachoCommandDispatch.output.safeParse({ commandIds: [] }).success,
    ).toBe(true);
    expect(
      tachoCommandDispatch.output.safeParse({ commandId: "tcm_a" }).success,
    ).toBe(false);
  });
});
