/**
 * The idle-host control poll (docs/specs/tacho/spec.md section 7.4):
 * acknowledge the outcomes of earlier commands and receive pending ones,
 * together with the same control envelope every ingest carries.
 * Machine-to-machine, authenticated by the host's API key.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  controlEnvelopeSchema,
  hostEnrollmentIdSchema,
  tachoCommandOutcomeSchema,
} from "../tacho/schemas";

export const tachoCommandFetch = registerCapability({
  name: "fetch_tacho_commands",
  domain: "tacho",
  description:
    "Acknowledge applied Tacho commands and fetch the pending ones with the host's control envelope.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z
    .object({
      host_enrollment_id: hostEnrollmentIdSchema,
      acknowledgements: z
        .array(
          z
            .object({
              command_id: z.string().min(1),
              outcome: tachoCommandOutcomeSchema.exclude(["pending"]),
              detail: z.string().max(512).optional(),
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

export type TachoCommandFetchInput = z.output<typeof tachoCommandFetch.input>;
export type TachoCommandFetchOutput = z.output<typeof tachoCommandFetch.output>;
