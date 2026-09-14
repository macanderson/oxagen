import { describe, expect, it } from "vitest";
import { tachoCommandFetch } from "./tacho.command.fetch";

const HOST = "tch_0123456789abcdefghjkmn";
const SCHEMA = "tacho.commands.v2";

describe("fetch_commands contract", () => {
  it("is the Appendix E name, headless, and never refused for lack of GAUs", () => {
    expect(tachoCommandFetch.name).toBe("fetch_commands");
    expect(tachoCommandFetch.surfaces).toEqual(["api"]);
    expect(tachoCommandFetch.mutates).toBe(true);
    expect(tachoCommandFetch.noBillingGate).toBe(true);
  });

  it("accepts a bare poll and acknowledgements in the five statuses a host can assert", () => {
    expect(
      tachoCommandFetch.input.parse({
        schema: SCHEMA,
        host_enrollment_id: HOST,
      }).acknowledgements,
    ).toEqual([]);
    for (const status of [
      "received",
      "acknowledged",
      "applied",
      "expired",
      "failed",
    ]) {
      const parsed = tachoCommandFetch.input.parse({
        schema: SCHEMA,
        host_enrollment_id: HOST,
        acknowledgements: [{ command_id: "tcm_1", status, applied_at_seq: 42 }],
        daemon: { version: "2.1.1", hooks_ok: true },
      });
      expect(parsed.acknowledgements[0]?.status).toBe(status);
    }
  });

  it("refuses the v1 body, the statuses Oxagen owns, and an unknown member (negative)", () => {
    const refuse = (input: unknown) =>
      expect(tachoCommandFetch.input.safeParse(input).success).toBe(false);
    // A v1 collector: no schema tag, `outcome` from the five-word set.
    refuse({
      host_enrollment_id: HOST,
      acknowledgements: [{ command_id: "x", outcome: "applied" }],
    });
    refuse({ schema: "tacho.commands.v1", host_enrollment_id: HOST });
    for (const status of ["queued", "sent", "cancelled", "draft"]) {
      refuse({
        schema: SCHEMA,
        host_enrollment_id: HOST,
        acknowledgements: [{ command_id: "x", status }],
      });
    }
    refuse({ schema: SCHEMA, host_enrollment_id: HOST, extra: 1 });
  });

  it("answers with the control envelope, whose commands carry the resolved mode", () => {
    const output = tachoCommandFetch.output.parse({
      acknowledged: 1,
      control: {
        host_status: "paused",
        deny_generation: { org: 3, workspace: 1 },
        bundle_etag: "e",
        commands: [
          {
            id: "tcm_2",
            command: "steer",
            session_uuid: "3f2b7a5e-8c1d-4e6f-9a0b-1c2d3e4f5a6b",
            payload: { text: "wrap up" },
            requested_mode: "interrupt",
            delivery_mode: "next_step",
            degraded_reason: "harness_tier",
            reason: "operator steer",
            issued_at: "2026-09-08T10:00:00.000Z",
            expires_at: null,
          },
        ],
      },
    });
    expect(output.control.commands[0]?.delivery_mode).toBe("next_step");
    // The operator's reason rides the envelope in its own field, not under
    // `payload`: the collector shows it at the boundary a pause denies.
    expect(output.control.commands[0]?.reason).toBe("operator steer");
  });
});
