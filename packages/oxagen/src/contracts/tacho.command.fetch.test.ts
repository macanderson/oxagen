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

  it("accepts the bundle fields an upgraded daemon says it can parse", () => {
    // This `daemon` object is declared here and `.strict()`, so a field the
    // collector learned to send and this contract never named would refuse
    // the poll of every upgraded host -- the compatibility break of #3182's
    // review finding, pointed the other way. An old daemon sends none.
    const withFeatures = tachoCommandFetch.input.parse({
      schema: SCHEMA,
      host_enrollment_id: HOST,
      daemon: { version: "2.2.0", bundle_features: ["gateway_tools"] },
    });
    expect(withFeatures.daemon?.bundle_features).toEqual(["gateway_tools"]);
    expect(
      tachoCommandFetch.input.parse({
        schema: SCHEMA,
        host_enrollment_id: HOST,
        daemon: { version: "2.1.1" },
      }).daemon?.bundle_features,
    ).toBeUndefined();
  });

  it("accepts the base-URL report a drift-reporting daemon sends", () => {
    // The same `.strict()` trap as the case above, and the one this PR walked
    // into: `tachod` sends its whole health report on the command poll, so a
    // daemon that learned to report `model_base_urls` had every poll refused
    // until this contract named the field. The command poll is the channel
    // pause, cancel and steer arrive on, so the cost is an operator whose
    // controls stop working on exactly the hosts that upgraded.
    const reported = tachoCommandFetch.input.parse({
      schema: SCHEMA,
      host_enrollment_id: HOST,
      daemon: {
        version: "2.2.0",
        model_base_urls: [
          {
            harness: "claude_code",
            key: "env.ANTHROPIC_BASE_URL",
            ours: false,
            shadowed_by: "/Library/Application Support/ClaudeCode/managed.json",
          },
        ],
      },
    });
    expect(reported.daemon?.model_base_urls?.[0]?.ours).toBe(false);
    expect(
      tachoCommandFetch.input.parse({
        schema: SCHEMA,
        host_enrollment_id: HOST,
        daemon: { version: "2.1.1" },
      }).daemon?.model_base_urls,
    ).toBeUndefined();
  });

  it("accepts the credential bases a brokering daemon reports, and never a secret", () => {
    // ADR-142: the daemon says which providers it holds a credential for.
    // The same strictness argument as `bundle_features`: unnamed here, the
    // field would refuse the poll of every host that brokers.
    const parsed = tachoCommandFetch.input.parse({
      schema: SCHEMA,
      host_enrollment_id: HOST,
      daemon: {
        version: "2.2.0",
        credentials: [
          { provider: "anthropic", basis: "gateway_brokered" },
          { provider: "openai", basis: "harness_held" },
        ],
      },
    });
    expect(parsed.daemon?.credentials).toHaveLength(2);
    expect(() =>
      tachoCommandFetch.input.parse({
        schema: SCHEMA,
        host_enrollment_id: HOST,
        daemon: {
          credentials: [
            {
              provider: "anthropic",
              basis: "gateway_brokered",
              secret: "sk-ant-x",
            },
          ],
        },
      }),
    ).toThrow();
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
