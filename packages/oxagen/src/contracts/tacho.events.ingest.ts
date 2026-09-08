/**
 * Ingest a batch of `tacho/1.0` events from an enrolled host
 * (docs/specs/tacho/spec.md section 3.1 step 3; column contract in
 * data-model.md section 2).
 *
 * Machine-to-machine only, authenticated by the host's API key. Tenant
 * identity comes from the key, never from the body: a batch naming another
 * host or workspace is rejected in full. The response doubles as the control
 * channel: it carries the host's status, the deny generations, the bundle
 * etag, and any pending commands, so an active host needs no separate poll.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { controlEnvelopeSchema, tachoBatchSchema } from "../tacho/schemas";

const MAX_BATCH = 200;

export const tachoEventsIngest = registerCapability({
  name: "ingest_tacho_events",
  domain: "tacho",
  description:
    "Ingest a batch of hash-chained tacho/1.0 events from an enrolled host and return its control envelope.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  agent: {
    requiresApproval: false,
    riskLevel: "high",
    category: "telemetry",
  },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: tachoBatchSchema,
  output: z
    .object({
      accepted: z.number().int().min(1).max(MAX_BATCH),
      /** The idempotency ids of the accepted events, in request order. */
      event_ids: z
        .array(z.string().regex(/^evt_[0-9a-f]{64}$/))
        .min(1)
        .max(MAX_BATCH),
      /** Sessions whose chain the control plane could not verify from this batch. */
      chain_breaks: z
        .array(
          z
            .object({
              session_uuid: z.string().uuid(),
              at_seq: z.number().int().nonnegative(),
              reason: z.string().max(256),
            })
            .strict(),
        )
        .max(MAX_BATCH),
      control: controlEnvelopeSchema,
    })
    .strict()
    .superRefine((output, context) => {
      if (output.accepted !== output.event_ids.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["event_ids"],
          message: "event_ids length must equal accepted",
        });
      }
    }),
});

export type TachoEventsIngestInput = z.output<typeof tachoEventsIngest.input>;
export type TachoEventsIngestOutput = z.output<typeof tachoEventsIngest.output>;
