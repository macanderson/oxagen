import { describe, expect, it } from "vitest";
import { tachoCommandFetch } from "./tacho.command.fetch";

const HOST = "tch_0123456789abcdefghjkmn";

describe("tachoCommandFetch", () => {
  it("accepts a bare poll and acknowledgements with outcomes", () => {
    expect(
      tachoCommandFetch.input.parse({ host_enrollment_id: HOST })
        .acknowledgements,
    ).toEqual([]);
    const parsed = tachoCommandFetch.input.parse({
      host_enrollment_id: HOST,
      acknowledgements: [
        { command_id: "tcm_1", outcome: "applied", applied_at_seq: 42 },
      ],
      daemon: { version: "2.1.1", hooks_ok: true },
    });
    expect(parsed.acknowledgements[0]?.outcome).toBe("applied");
  });

  it("refuses a pending acknowledgement and an unknown member", () => {
    expect(
      tachoCommandFetch.input.safeParse({
        host_enrollment_id: HOST,
        acknowledgements: [{ command_id: "x", outcome: "pending" }],
      }).success,
    ).toBe(false);
    expect(
      tachoCommandFetch.input.safeParse({ host_enrollment_id: HOST, extra: 1 })
        .success,
    ).toBe(false);
  });

  it("answers with the control envelope", () => {
    const output = tachoCommandFetch.output.parse({
      acknowledged: 1,
      control: {
        host_status: "paused",
        deny_generation: { org: 3, workspace: 1 },
        bundle_etag: "e",
        commands: [
          {
            id: "tcm_2",
            command: "pause",
            session_uuid: null,
            payload: { reason: "ops" },
            issued_at: "2026-09-08T10:00:00.000Z",
            expires_at: null,
          },
        ],
      },
    });
    expect(output.control.commands[0]?.command).toBe("pause");
    expect(tachoCommandFetch.name).toBe("fetch_tacho_commands");
  });
});
