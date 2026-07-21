import { z } from "zod";
import { registerCapability } from "../registry";

const BOUNDED_IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/;
const SAFE_DIMENSION_SEGMENT_PATTERN = /^[A-Za-z0-9._:-]+$/;
const EVENT_ID_PATTERN = /^evt_[0-9a-f]{64}$/;

const boundedIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(BOUNDED_IDENTIFIER_PATTERN);

const safeDimensionSegmentSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(SAFE_DIMENSION_SEGMENT_PATTERN)
  .refine((value) => value !== "." && value !== "..");

const providerDimensionSchema = safeDimensionSegmentSchema;

const modelDimensionSchema = z
  .string()
  .min(1)
  .max(160)
  .refine((value) => {
    const segments = value.split("/");
    return (
      segments.length <= 2 &&
      segments.every(
        (segment) => safeDimensionSegmentSchema.safeParse(segment).success,
      )
    );
  });

const eventIdSchema = z.string().regex(EVENT_ID_PATTERN);
const nonnegativeSafeIntegerSchema = z.number().int().nonnegative().safe();

export const stellaOperationalEventV1Schema = z
  .object({
    schema: z.literal("stella.operational.v1"),
    event_class: z.literal("execution_rollup"),
    event_id: eventIdSchema,
    enrollment_id: boundedIdentifierSchema,
    organization_id: boundedIdentifierSchema,
    workspace_id: boundedIdentifierSchema,
    provider: providerDimensionSchema,
    model: modelDimensionSchema,
    outcome: z.enum([
      "completed",
      "error",
      "failed",
      "aborted",
      "cancelled",
      "indeterminate",
      "verification_failed",
      "goal_met",
      "goal_unmet",
    ]),
    duration_ms: nonnegativeSafeIntegerSchema,
    input_tokens: nonnegativeSafeIntegerSchema,
    output_tokens: nonnegativeSafeIntegerSchema,
    cost_microusd: nonnegativeSafeIntegerSchema,
    tool_call_count: nonnegativeSafeIntegerSchema,
    changed_file_count: nonnegativeSafeIntegerSchema,
    produced_output: z.boolean(),
  })
  .strict();

const stellaOperationalBatchV1Schema = z
  .object({
    schema: z.literal("stella.operational.batch.v1"),
    events: z.array(stellaOperationalEventV1Schema).min(1).max(50),
  })
  .strict();

const ingestStellaOperationalTelemetryOutputSchema = z
  .object({
    accepted: z.number().int().min(1).max(50),
    event_ids: z.array(eventIdSchema).min(1).max(50),
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
  });

export const telemetryStellaIngest = registerCapability({
  name: "ingest_stella_operational_telemetry",
  domain: "telemetry",
  description:
    "Ingest an authenticated, content-free batch of Stella operational execution rollups.",
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
  input: stellaOperationalBatchV1Schema,
  output: ingestStellaOperationalTelemetryOutputSchema,
});

export type StellaOperationalEventV1 = z.output<
  typeof stellaOperationalEventV1Schema
>;
export type TelemetryStellaIngestInput = z.output<
  typeof telemetryStellaIngest.input
>;
export type TelemetryStellaIngestOutput = z.output<
  typeof telemetryStellaIngest.output
>;
