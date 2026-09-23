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
import {
  PROOF_OBSERVED_KIND,
  proofObservedBodySchema,
} from "@oxagen/run-evidence";

const MAX_BATCH = 200;

/**
 * The batch as the host ships it, with every `proof.observed` body held to
 * its schema (@oxagen/run-evidence, ADR-064): the leaf tacho package carries
 * that body opaquely, so the control plane is where a malformed verdict is
 * refused, and it refuses the whole batch at the input parse. The refinement
 * sits on `events` so the input stays an object (v2 `ingest_frames` unions it).
 */
const ingestBatchSchema = tachoBatchSchema.extend({
  events: tachoBatchSchema.shape.events.superRefine((events, ctx) => {
    events.forEach((event, index) => {
      if (event.kind !== PROOF_OBSERVED_KIND) return;
      const parsed = proofObservedBodySchema.safeParse(event.body);
      if (parsed.success) return;
      for (const issue of parsed.error.issues)
        ctx.addIssue({ ...issue, path: [index, "body", ...issue.path] });
    });
  }),
});

export const tachoEventsIngest = registerCapability({
  name: "ingest_tacho_events",
  domain: "tacho",
  description:
    "Ingest a batch of hash-chained tacho/1.0 events from an enrolled host and return its control envelope.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  // The recording itself is never refused and never billed as an action. An
  // organisation whose governed action units have run out still has its runs
  // recorded: the admission gate refuses its next server-side action, not the
  // evidence of the last one. What the batch carries is billed instead. The
  // handler records one governed action per tool call a wrapped harness made
  // and Tacho allowed, on the per-action ledger (ADR-158), and the ledger's
  // idempotency key makes a re-sent batch bill nothing twice.
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
  input: ingestBatchSchema,
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
      /**
       * Bodies the control plane did not retain: the event was recorded
       * without one and the session carries a `body_missing` gap. Reasons:
       * `unknown_event`, `digest_mismatch`, `credential_detected`,
       * `retention_digest_only`, `no_content_digest`.
       */
      body_rejections: z
        .array(
          z
            .object({
              event_id_idem: z.string().regex(/^evt_[0-9a-f]{64}$/),
              reason: z.enum([
                "unknown_event",
                "digest_mismatch",
                "credential_detected",
                "retention_digest_only",
                // The workspace retains exact bytes, but not for this
                // frame's content class.
                "retention_class_excluded",
                "no_content_digest",
              ]),
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
