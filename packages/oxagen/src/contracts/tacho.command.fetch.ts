/**
 * `fetch_commands` (Mission Control spec Appendix E, "control channel;
 * headless"): the idle-host control poll of `docs/specs/tacho/spec.md`
 * section 7.4. A host acknowledges the commands it took and applied, in the
 * §7.4 status vocabulary, and receives the pending ones together with the
 * control envelope every ingest carries. Machine-to-machine, authenticated by
 * the host's API key.
 *
 * Registered in place of `fetch_tacho_commands` under its Appendix E name
 * (ADR-025, no alias). The body carries `schema: "tacho.commands.v2"`: a v1
 * collector, which acknowledged with `outcome` from the five-word set, is
 * refused by the strict shape.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  TACHO_COMMANDS_SCHEMA,
  controlEnvelopeSchema,
  hostEnrollmentIdSchema,
  tachoCommandAckStatusSchema,
} from "../tacho/schemas";

export const tachoCommandFetch = registerCapability({
  name: "fetch_commands",
  domain: "control",
  description:
    "Acknowledge applied commands and fetch the pending ones with the host's control envelope.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  mutates: true,
  // The control channel is how a pause or a revoke reaches a running agent;
  // gating it on a bucket would let a lapsed invoice leave an agent
  // unstoppable.
  noBillingGate: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z
    .object({
      schema: z.literal(TACHO_COMMANDS_SCHEMA),
      host_enrollment_id: hostEnrollmentIdSchema,
      acknowledgements: z
        .array(
          z
            .object({
              command_id: z.string().min(1),
              /** `applied` is the only success word: the effect is in the record. */
              status: tachoCommandAckStatusSchema,
              detail: z.string().max(512).optional(),
              /** The frame sequence the effect landed on (Appendix A.6). */
              applied_at_seq: z.number().int().nonnegative().optional(),
              session_uuid: z.string().uuid().optional(),
            })
            .strict(),
        )
        .max(100)
        .default([]),
      daemon: z
        .object({
          version: z.string().max(64).optional(),
          uptime_s: z.number().int().nonnegative().optional(),
          spool_depth: z.number().int().nonnegative().optional(),
          hooks_ok: z.boolean().optional(),
          otel_ok: z.boolean().optional(),
          /**
           * The bundle fields this daemon can parse, mirroring
           * `daemonHealthSchema`. This object is `.strict()` too, so leaving
           * it out here would refuse the poll of every **upgraded** host —
           * the same shape of break, in the other direction.
           */
          bundle_features: z.array(z.string().max(64)).max(32).optional(),
          /**
           * Whether each routed harness still points at the loopback proxy,
           * mirroring `daemonHealthSchema.model_base_urls`. The daemon sends
           * its whole health report on this poll, minus the two fields the
           * ingest path owns, so the same `.strict()` trap applies: a field
           * the collector learned to send and this object does not name
           * refuses the command poll of every upgraded host — which is the
           * channel pause, cancel and steer arrive on.
           */
          model_base_urls: z
            .array(
              z
                .object({
                  harness: z.string().max(64),
                  key: z.string().max(128),
                  ours: z.boolean(),
                  shadowed_by: z.string().max(512).optional(),
                })
                .strict(),
            )
            .max(8)
            .optional(),
          /**
           * Which model providers the host brokers (ADR-143), mirroring
           * `daemonHealthSchema.credentials`: a basis per provider, never a
           * secret. Same reason as `bundle_features`: this object is
           * `.strict()`, so a field the daemon sends and this contract does
           * not name refuses every upgraded host's poll.
           */
          credentials: z
            .array(
              z
                .object({
                  provider: z.enum(["anthropic", "openai"]),
                  basis: z.enum(["gateway_brokered", "harness_held"]),
                })
                .strict(),
            )
            .max(8)
            .optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  output: z
    .object({
      acknowledged: z.number().int().nonnegative(),
      control: controlEnvelopeSchema,
    })
    .strict(),
});

export type FetchCommandsInput = z.output<typeof tachoCommandFetch.input>;
export type FetchCommandsOutput = z.output<typeof tachoCommandFetch.output>;
