import { z } from "zod";
import { defineTool } from "./_define";
import { tachoEventsIngest } from "../tacho.events.ingest";
import { telemetryStellaIngest } from "../telemetry.stella.ingest";
import { controlEnvelopeSchema } from "../../tacho/schemas";

/**
 * Appendix E: `ingest_frames` — "the one evidence ingress; headless". Absorbs
 * `ingest_tacho_events`, `record_execution`,
 * `ingest_stella_operational_telemetry` and `debug_execution`.
 *
 * This is the widest carry in the batch and the narrowest job in it. Four
 * contracts go in; one ingress comes out, and two of the four contribute no
 * fields at all. That is rule 5 working as intended, so the reasoning is spelt
 * out rather than left in the `drops` array.
 *
 * **Why the input is a union and not a merge.** Two wire dialects reach this
 * door: the hash-chained `tacho.batch.v1` a wrapped host ships, and the
 * content-free `stella.operational.batch.v1` rollup Stella ships (§4.4 — Stella
 * hosts the protocol itself, so Oxagen is a provider to it rather than a
 * wrapper around it). Both are strict objects with a literal `schema` field, so
 * a discriminated union on that field is the whole of the dispatch, and both
 * arms are the *original* contract inputs — not copies. Merging them would
 * produce a schema that accepts a chained batch with no chain and a rollup with
 * a `prev_hash`.
 *
 * **Why `record_execution` contributes nothing.** §8.1 is explicit: "Turns and
 * steps are not rows of their own. They are derived from frames and
 * materialized in the rollups (§12.7)." `record_execution` exists to write
 * those rows — an execution, its steps, and each step's tool calls — from a
 * single call by a trusted caller. In the target model every one of those is a
 * projection of frames that already arrived here, so carrying its fields would
 * create a second, unchained way to assert what a run did. Its cost figures go
 * the same way: §12.3 writes a cost record on the `model.response` frame, not
 * on a summary submitted after the fact.
 *
 * **Why `debug_execution` contributes nothing.** It is a read — a deterministic
 * failure frame assembled on demand from the span tree, the ClickHouse error
 * events and the logs. Under §8.2 the error events *are* frames (`error` kind),
 * so the diagnosis is a projection over evidence this tool already ingested and
 * belongs on the read side with `get_run` and §14's Run page. Its `summarize`
 * flag could not come here in any case: it runs a model call, and a headless
 * ingress that answers a fleet of hosts must not have a model in its path.
 *
 * **Headless, so the surface list is one entry.** Appendix E marks this tool
 * headless, which overrides the appendix's default API/MCP/UI exposure. Hosts
 * authenticate with their own scoped credential; there is no operator call.
 */
export const ingestFrames = defineTool({
  name: "ingest_frames",
  domain: "control",
  description:
    "Ingest a batch of evidence from an enrolled host or from Stella — hash-chained frames or content-free operational rollups — and return the host's control envelope.",
  mode: "sync",
  // Headless (Appendix E). Machine-to-machine only.
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  // Evidence must arrive even when an org's credit balance is zero: the
  // alternative is losing the record of what an agent did because the invoice
  // lapsed. Carried from both ingest sources.
  noBillingGate: true,

  absorbs: [
    "ingest_tacho_events",
    "record_execution",
    "ingest_stella_operational_telemetry",
    "debug_execution",
  ],
  drops: [
    // ── record_execution: the whole contract. §8.1 / §12.7. ────────────────
    {
      field: "agentId",
      from: "record_execution",
      why: "run identity is built by server code from the run token (§8.1 RunSpecV2), never asserted in an ingest body — tenant and principal come from the credential, as `ingest_tacho_events` already required",
    },
    {
      field: "agentVersionId",
      from: "record_execution",
      why: "the agent version digest is part of the run identity fixed at run start (§8.1), not a per-batch claim",
    },
    {
      field: "originType",
      from: "record_execution",
      why: "origin belongs to the run, established once at `agent_start` (§8.2); the enum also encodes today's execution taxonomy, which §3 retires along with the word",
    },
    {
      field: "originId",
      from: "record_execution",
      why: "follows originType; the durable equivalent is the run's task reference (§8.1)",
    },
    {
      field: "status",
      from: "record_execution",
      why: "a run's outcome is derived from its terminal frame and fixed at seal (§8.3), never submitted as a field",
    },
    {
      field: "inputPayload",
      from: "record_execution",
      why: "bodies are content-addressed blobs referenced by `content.digest` / `bytes_ref` on a frame (§8.2), so redaction can run before the bytes are written",
    },
    {
      field: "outputPayload",
      from: "record_execution",
      why: "same as inputPayload — §8.2",
    },
    {
      field: "failureReason",
      from: "record_execution",
      why: "carried by the `error` frame kind (§8.2), which is chained and therefore attributable",
    },
    {
      field: "startedAt",
      from: "record_execution",
      why: "derived from the first and last frame `ts` (§8.2); a separately asserted start time can disagree with the chain",
    },
    {
      field: "completedAt",
      from: "record_execution",
      why: "same as startedAt — §8.2",
    },
    {
      field: "latencyMs",
      from: "record_execution",
      why: "derived from frame timestamps in the rollups (§12.7)",
    },
    {
      field: "inputTokens",
      from: "record_execution",
      why: "§12.6 accounts tokens on every model call, from the `model.response` usage block; a batch-level total has no price entry to attach to",
    },
    {
      field: "outputTokens",
      from: "record_execution",
      why: "same as inputTokens — §12.6",
    },
    {
      field: "estimatedCostUsd",
      from: "record_execution",
      why: "§12.3 writes a cost record per frame in integer micro-USD with a `cost_basis`; a float dollar estimate with no basis cannot be reconciled (§12.4)",
    },
    {
      field: "steps",
      from: "record_execution",
      why: "§8.1: turns and steps are not rows of their own — they are derived from frames. The nested step and tool-call shapes go with it.",
    },
    {
      field: "output { executionId, status, createdAt }",
      from: "record_execution",
      why: "the ingress acknowledges frames, not a row it created; the ids that come back are frame ids",
    },

    // ── debug_execution: a read, not an ingress. ───────────────────────────
    {
      field: "executionId",
      from: "debug_execution",
      why: "diagnosis is a read over frames already ingested — it belongs with `get_run` and §14's Run page, not on the ingress",
    },
    {
      field: "depth",
      from: "debug_execution",
      why: "follows executionId — a bound on how much of the tree a reader gets back",
    },
    {
      field: "summarize",
      from: "debug_execution",
      why: "it runs one model call. A headless ingress answering every host in the fleet must have no model in its path (§4.5), and the deterministic ladder in ADR-021 §1 puts the model on the last rung in any case",
    },
    {
      field:
        "output (the failure frame: failingStep, errorClass, message, topFrames, relatedSpans, suspectFiles, errorEvents, logsSample, diagnosis, truncated)",
      from: "debug_execution",
      why: "a projection over `error` frames and the run tree (§8.2); it is produced on the read side and returns through `get_run`",
    },
  ],

  /**
   * Both ingest sources declare `riskLevel: "high"` with no approval, and that
   * carries: an ingress is high-risk because a bad batch corrupts the record
   * every later claim rests on, while requiring approval on a telemetry batch
   * would halt every host in the fleet. `debug_execution`'s `low` does not
   * carry — the stricter value wins and its job is not here anyway.
   */
  agent: { requiresApproval: false, riskLevel: "high", category: "telemetry" },
  // `record_execution` grades itself `low`/`allow`; the two ingest contracts
  // grade themselves `high`/`deny`. The stricter pair carries. Frames are the
  // evidence every audit, invoice and attestation is built on.
  sensitivity: "high",
  defaultEffect: "deny",
  // `record_execution` also granted workspace Owner/Member. Dropped: this is a
  // machine credential path, and a member with a session cookie must not be
  // able to write into the chain by hand.
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  // Writes frames, chain state, and the host's liveness counters.
  mutates: true,

  /**
   * The two dialects, each carried as the original contract's own input. The
   * `schema` literal on each batch is the discriminator, so "which wire is
   * this" is answered by the parse rather than by the handler.
   */
  input: z.discriminatedUnion("schema", [
    // `tacho.batch.v1`: hash-chained events with the host's daemon health.
    // Tenant identity comes from the credential, never from the body — a batch
    // naming another host or workspace is rejected in full.
    tachoEventsIngest.input,
    // `stella.operational.batch.v1`: content-free execution rollups, capped at
    // 50 per batch, with the dimension regexes that keep provider/model
    // segments from becoming path traversal in a metrics key.
    telemetryStellaIngest.input,
  ]),

  /**
   * One receipt shape for both dialects. Field names stay snake_case: this is a
   * wire contract that the daemon and the Stella emitter parse, and both
   * sources already spell it this way.
   *
   * The three counters are taken off `ingest_tacho_events`' output through
   * `sourceType()` because that output is a `ZodEffects` — it carries the
   * "event_ids length must equal accepted" refinement. Reaching through it
   * keeps the field definitions (including the `evt_` id regex) by reference;
   * the refinement itself is restated below because the shape gained a field.
   */
  output: z
    .object({
      accepted: tachoEventsIngest.output.sourceType().shape.accepted,
      /**
       * Idempotency ids of the accepted frames, in request order. Note the
       * shape is `evt_<64 hex>` — a content hash — while §8.2 describes
       * `event_id` as a ULID. The chain works either way (the hash chain is
       * `prev_hash`/`hash`, not this id), but the two spellings should be
       * reconciled before the frame envelope is published to customers.
       */
      event_ids: tachoEventsIngest.output.sourceType().shape.event_ids,
      /**
       * Sessions whose chain could not be verified from this batch. §8.3: a
       * gap is reported, never repaired — the same `seq` with a different hash
       * is refused and raised as a security incident.
       */
      chain_breaks: tachoEventsIngest.output.sourceType().shape.chain_breaks,
      /**
       * The control channel rides the ingest response so an active host needs
       * no separate poll (§7.4). Nullable because the Stella arm has no
       * enrolled host behind it: Stella enforces its own loop, so there is no
       * bundle etag or command queue to hand back.
       */
      control: controlEnvelopeSchema.nullable(),
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

export type IngestFramesInput = z.output<typeof ingestFrames.input>;
export type IngestFramesOutput = z.output<typeof ingestFrames.output>;
