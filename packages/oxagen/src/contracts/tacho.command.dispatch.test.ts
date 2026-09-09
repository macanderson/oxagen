import { describe, expect, it } from "vitest";
import { tachoCommandDispatch } from "./tacho.command.dispatch";

const HOST = "tch_0123456789abcdefghjkmn";

describe("tachoCommandDispatch", () => {
  it("accepts every command with defaults for payload and expiry", () => {
    for (const command of [
      "pause",
      "resume",
      "cancel",
      "message",
      "revoke",
      "refresh_bundle",
      "kill",
    ]) {
      const parsed = tachoCommandDispatch.input.parse({
        hostEnrollmentId: HOST,
        command,
      });
      expect(parsed.payload).toEqual({});
      expect(parsed.expiresInS).toBe(3600);
    }
    expect(
      tachoCommandDispatch.input.parse({
        hostEnrollmentId: HOST,
        sessionUuid: "3f2b7a5e-8c1d-4e6f-9a0b-1c2d3e4f5a6b",
        command: "message",
        payload: { text: "hi" },
      }).payload,
    ).toEqual({ text: "hi" });
  });

  it("refuses an unknown command, a bad session id, and an out-of-range expiry", () => {
    expect(
      tachoCommandDispatch.input.safeParse({
        hostEnrollmentId: HOST,
        command: "reboot",
      }).success,
    ).toBe(false);
    expect(
      tachoCommandDispatch.input.safeParse({
        hostEnrollmentId: HOST,
        command: "pause",
        sessionUuid: "nope",
      }).success,
    ).toBe(false);
    expect(
      tachoCommandDispatch.input.safeParse({
        hostEnrollmentId: HOST,
        command: "pause",
        expiresInS: 5,
      }).success,
    ).toBe(false);
  });

  it("answers with the queued command's identity", () => {
    expect(
      tachoCommandDispatch.output.parse({
        commandId: "tcm_x",
        outcome: "pending",
        issuedAt: "2026-09-08T10:00:00.000Z",
        expiresAt: "2026-09-08T11:00:00.000Z",
      }).outcome,
    ).toBe("pending");
    expect(tachoCommandDispatch.name).toBe("dispatch_tacho_command");
  });
});
