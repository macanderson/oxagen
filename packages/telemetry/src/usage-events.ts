/**
 * Canonical shape of an anonymous CLI usage-telemetry event — the allowlist
 * enforced by `POST /v1/telemetry/usage` (apps/api/src/routes/v1/telemetry.usage.ts).
 *
 * This file is intentionally the ONLY thing in @oxagen/telemetry that a
 * distributed, potentially-open-sourced client is allowed to depend on: it
 * imports nothing but `zod` (no ClickHouse client, no OpenTelemetry SDK). It
 * is exported as its own package.json subpath ("@oxagen/telemetry/usage-events")
 * so a bundler never pulls the heavy analytics backend into a CLI build —
 * see packages/telemetry/package.json `exports`.
 *
 * The CLI itself (apps/cli/src/telemetry/usage.ts) does NOT import this file
 * at runtime — it ships its own dependency-free copy of the allowlist so the
 * published CLI has zero production coupling to this workspace package. A
 * test-only cross-check (apps/cli/src/telemetry/usage.test.ts, via a
 * devDependency) asserts the two lists never drift apart.
 *
 * Every field is anonymous/aggregate by construction:
 *   - `.strict()` rejects any payload key outside this list — a bad or
 *     compromised client cannot smuggle an extra field (a prompt, a file
 *     path, a stack trace) past the ingest route.
 *   - Every String field is bounded and shape-constrained (a short lowercase
 *     identifier, a UUID, or a validated tool->count JSON map) so even a
 *     value that fits an allowlisted key cannot carry free-text content.
 *   - `timestamp` is deliberately NOT part of this client-facing schema — the
 *     ingest route stamps it server-side (see telemetry.usage.ts) so a wrong
 *     or adversarial local clock can never produce spoofed historical rows.
 */
import { z } from "zod";

/** Short, lowercase, identifier-shaped token — the general categorical shape. */
const IDENTIFIER_RE = /^[a-z][a-z0-9_-]*$/;
/** Same as {@link IDENTIFIER_RE} but also allows the empty string ("no value"). */
const IDENTIFIER_OR_EMPTY_RE = /^([a-z][a-z0-9_-]*)?$/;

/** UInt8-as-boolean: exactly 0 or 1, never a truthy/falsy JS value. */
const BoolFlag = z.union([z.literal(0), z.literal(1)]);

/**
 * `tool_calls_json` must parse to a plain object mapping short identifier
 * tool names to non-negative integer counts — e.g. {"code_graph":3,"grep":1}.
 * Rejecting anything else (nested objects, string values, arrays) makes it
 * structurally impossible to carry tool arguments, file contents, or results
 * through this field, not just a matter of client good behavior.
 */
const ToolCallsJsonSchema = z
  .string()
  .max(2000)
  .default("{}")
  .refine(
    (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return false;
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        return false;
      }
      return Object.entries(parsed as Record<string, unknown>).every(
        ([key, value]) =>
          IDENTIFIER_RE.test(key) &&
          typeof value === "number" &&
          Number.isInteger(value) &&
          value >= 0,
      );
    },
    {
      message:
        "tool_calls_json must be a JSON object of identifier -> non-negative integer",
    },
  );

/** The four real tiers plus "mixed" (a session that used more than one) and "" (unknown). */
const ModelTierSchema = z.enum(["fast", "balanced", "precise", "mixed", ""]);

/**
 * The client-facing request-body allowlist for `POST /v1/telemetry/usage`.
 * `.strict()` is the enforcement point: any key not listed here fails
 * validation rather than being silently dropped, so a bad client gets a
 * clear 400 instead of a route that quietly accepts unknown fields forever.
 */
export const UsageEventPayloadSchema = z
  .object({
    install_id: z.string().uuid(),
    session_id: z.string().uuid(),
    oxagen_version: z
      .string()
      .min(1)
      .max(32)
      .regex(
        /^[a-zA-Z0-9_.+-]+$/,
        "oxagen_version must look like a version string",
      ),
    os: z.string().min(1).max(32).regex(IDENTIFIER_RE),
    arch: z.string().min(1).max(32).regex(IDENTIFIER_RE),
    command: z.string().min(1).max(32).regex(IDENTIFIER_RE),
    model_tier: ModelTierSchema,
    best_of_n: z.number().int().min(0).max(255),
    graph_used: BoolFlag,
    pipeline_used: BoolFlag,
    tui: BoolFlag,
    headless: BoolFlag,
    byok: BoolFlag,
    tool_calls_json: ToolCallsJsonSchema,
    step_count: z.number().int().min(0).max(65_535),
    duration_ms: z.number().int().min(0).max(4_294_967_295),
    error_type: z.string().max(32).regex(IDENTIFIER_OR_EMPTY_RE),
    exit_status: z.string().min(1).max(32).regex(IDENTIFIER_RE),
  })
  .strict();

export type UsageEventPayload = z.infer<typeof UsageEventPayloadSchema>;

/**
 * The exact allowlisted key set, derived from the schema itself so this list
 * can never drift from what `.strict()` actually enforces. Consumed by:
 *   - the ingest route's defense-in-depth (belt-and-suspenders key check)
 *   - tests, in both this package and apps/cli, that assert "the built
 *     payload contains ONLY these keys"
 */
export const USAGE_EVENT_ALLOWED_KEYS = Object.keys(
  UsageEventPayloadSchema.shape,
) as (keyof UsageEventPayload)[];

export type UsageEventValidationResult =
  | { ok: true; data: UsageEventPayload }
  | { ok: false; error: string };

/**
 * Parse + validate an unknown request body against the allowlist. Never
 * throws; returns a discriminated result so route code stays a one-liner.
 * The error string is a short, static description (zod issue path + code) —
 * it never echoes the offending value back, so an attacker's payload content
 * is never reflected into a response body or a log line.
 */
export function parseUsageEventPayload(
  input: unknown,
): UsageEventValidationResult {
  const result = UsageEventPayloadSchema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  const issue = result.error.issues[0];
  const path = issue?.path.join(".") || "(root)";
  return {
    ok: false,
    error: `Invalid usage event at "${path}": ${issue?.code ?? "invalid"}`,
  };
}
