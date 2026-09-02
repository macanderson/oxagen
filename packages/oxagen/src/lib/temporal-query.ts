import { z } from "zod";

/**
 * Shared bi-temporal query surface for graph read capabilities.
 *
 * A time-aware graph read takes two optional instants, one per time axis:
 *   • asOf       — valid time: "what was true in the world at this instant"
 *   • asKnownAt  — transaction time: "using only what we had recorded by this instant"
 *
 * Both default to now, so a caller that passes neither sees exactly the
 * currently-valid, currently-known facts — existing callers are unaffected.
 */
export const asOfField = z
  .string()
  .datetime()
  .optional()
  .describe(
    "Valid-time instant (ISO-8601): return facts that were true in the world at this time. " +
      "Omit for now (currently-valid facts).",
  );

export const asKnownAtField = z
  .string()
  .datetime()
  .optional()
  .describe(
    "Transaction-time instant (ISO-8601): return facts as they were known/recorded at this time. " +
      "Omit for now (currently-known facts).",
  );

/**
 * The four bi-temporal validity properties surfaced on a returned edge so agents
 * and the UI can cite "true as of X, recorded Y". Null upper bounds mean the fact
 * is still valid / still known; null lower bounds appear only on unstamped legacy
 * edges (pre-backfill).
 */
export const edgeValiditySchema = z.object({
  validFrom: z
    .string()
    .nullable()
    .describe(
      "Valid-time start (ISO-8601) — when the fact became true in the world",
    ),
  validTo: z
    .string()
    .nullable()
    .describe(
      "Valid-time end (ISO-8601), or null while the fact is still true",
    ),
  recordedAt: z
    .string()
    .nullable()
    .describe(
      "Transaction-time start (ISO-8601) — when we recorded the assertion",
    ),
  invalidatedAt: z
    .string()
    .nullable()
    .describe(
      "Transaction-time end (ISO-8601), or null while the assertion stands",
    ),
});

export type EdgeValidity = z.output<typeof edgeValiditySchema>;

/**
 * Write-side bi-temporal inputs, shared by edge/relationship write capabilities.
 *
 *   observedAt — valid-time of the asserted fact (its event time). Omit and the
 *                write stamps validFrom = now.
 *   supersede  — when true, this write is treated as the single valid object for
 *                (source, relationshipType): any other currently-open edge of the
 *                same type from the same source is *closed* (validTo / invalidatedAt
 *                stamped) rather than left to contradict the new fact. Defaults to
 *                false so additive (multi-valued) predicates are unchanged.
 */
export const observedAtField = z
  .string()
  .datetime()
  .optional()
  .describe(
    "Valid-time of the fact (ISO-8601): when it became true in the world. Omit to stamp now.",
  );

export const supersedeField = z
  .boolean()
  .optional()
  .describe(
    "Treat this as a single-valued fact: close any other currently-open edge of the same type " +
      "from the same source (preserving history) instead of leaving a contradiction. Default false.",
  );
