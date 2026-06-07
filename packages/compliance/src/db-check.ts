// db-check.ts — programmatic generation of the security_events CHECK-constraint
// SQL from the single-source TS unions in security-event-types.ts.
//
// This eliminates the third hand-maintained copy of the taxonomy (the migration
// DDL). The Drizzle schema builds its `check()` constraint from these helpers,
// and migration authors generate the exact constraint body with
// `generateEventTypeCheckClause()` rather than retyping the list.
//
// Pure string builders — no DB dependency, no SQL execution. Quoting is a
// single-quote SQL string literal; the inputs are compile-time constants from
// our own const-union, never user input, so there is no injection surface.

import {
  SECURITY_EVENT_TYPES,
  SECURITY_OUTCOMES,
  type SecurityEventType,
  type SecurityOutcome,
} from "./security-event-types";

/** Quote one value as a SQL single-quoted string literal. */
function sqlQuote(value: string): string {
  // Escape embedded single quotes per SQL standard ('' ). Our constants never
  // contain them, but this keeps the helper correct if the taxonomy ever grows
  // a value with an apostrophe.
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Comma-separated, single-quoted list of every event type — e.g.
 * `'auth.sign_in', 'auth.sign_out', ...`. Use inside an `IN (...)` clause.
 */
export function quotedEventTypeList(
  types: readonly SecurityEventType[] = SECURITY_EVENT_TYPES,
): string {
  return types.map(sqlQuote).join(", ");
}

/** Comma-separated, single-quoted list of every outcome. */
export function quotedOutcomeList(
  outcomes: readonly SecurityOutcome[] = SECURITY_OUTCOMES,
): string {
  return outcomes.map(sqlQuote).join(", ");
}

/**
 * Full `<column> IN (...)` boolean expression for the event_type CHECK
 * constraint. Pass the column name as it appears in the target table.
 */
export function generateEventTypeCheckClause(column = "event_type"): string {
  return `${column} IN (${quotedEventTypeList()})`;
}

/**
 * Full `<column> IN (...)` boolean expression for the outcome CHECK constraint.
 */
export function generateOutcomeCheckClause(column = "outcome"): string {
  return `${column} IN (${quotedOutcomeList()})`;
}
