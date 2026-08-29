// packages/database/src/security.ts
//
// Factory that wires the @oxagen/telemetry AuditInsertFn to the Drizzle
// database client. Callers (API bootstrap, MCP bootstrap, auth hooks) call
// makeSecurityEventInserter() once and pass the resulting fn to
// setSecurityEventEmitter or directly to recordSecurityEvent.
//
// The insert runs through withSystemDb (RLS bypass) because the audit record
// MUST be written even when there is no active tenant scope — the kernel emits
// a `capability.invoke_denied` for the no_tenant_scope deny path BEFORE any
// scope is established, and security_events is itself an RLS-policied table.
// Without bypass the audit write would fail closed and we would lose the very
// record that proves we denied a cross-tenant attempt.
//
// This file is the ONLY place in @oxagen/database that couples to the
// @oxagen/telemetry type contract — keeping the coupling explicit and
// locatable.

import {
  recordSecurityEvent,
  recordSecurityEventAsync,
  type AuditInsertFn,
  type SecurityEventInput,
} from "@oxagen/telemetry";
import { schema } from "./index";
import { withSystemDb } from "./tenant";

/**
 * Returns an AuditInsertFn bound to the given Drizzle database instance.
 * Wire the result into the kernel emitter or pass it directly to
 * recordSecurityEvent / recordSecurityEventAsync from @oxagen/telemetry.
 *
 * @example
 * ```ts
 * import { makeSecurityEventInserter } from "@oxagen/database/security";
 * import { setSecurityEventEmitter, recordSecurityEvent } from "@oxagen/telemetry";
 *
 * // Surface bootstrap (API server, MCP server):
 * const insert = makeSecurityEventInserter();
 * setSecurityEventEmitter((kernelEvent) => {
 *   recordSecurityEvent(insert, {
 *     eventType: kernelEvent.outcome === "allow"
 *       ? "capability.invoke_allowed"
 *       : kernelEvent.outcome === "deny"
 *         ? "capability.invoke_denied"
 *         : "capability.invoke_error",
 *     actorUserId: kernelEvent.actorUserId,
 *     orgId: kernelEvent.orgId,
 *     workspaceId: kernelEvent.workspaceId,
 *     capability: kernelEvent.capability,
 *     outcome: kernelEvent.outcome === "allow" ? "allow"
 *             : kernelEvent.outcome === "deny"  ? "deny"
 *             : "error",
 *     ip: null,        // not available at kernel level — enrich at surface layer
 *     userAgent: null,
 *     requestId: kernelEvent.requestId,
 *   });
 * });
 * ```
 */
export function makeSecurityEventInserter(): AuditInsertFn {
  return async (event: SecurityEventInput): Promise<void> => {
    await withSystemDb((tx) =>
      tx.insert(schema.securityEvents).values({
        occurredAt: event.occurredAt,
        eventType: event.eventType,
        actorUserId: event.actorUserId ?? undefined,
        orgId: event.orgId,
        workspaceId: event.workspaceId ?? undefined,
        capability: event.capability ?? undefined,
        outcome: event.outcome,
        ip: event.ip ?? undefined,
        userAgent: event.userAgent ?? undefined,
        requestId: event.requestId ?? undefined,
      }),
    );
  };
}

// ---------------------------------------------------------------------------
// Call-site registry — emitSecurityEvent / emitSecurityEventAsync
//
// One call against a single process-wide inserter keeps wiring a new
// privileged mutation to a one-liner, and lets the coverage invariant test
// (packages/compliance) assert the registry is the only emit path.
//
// The inserter uses withSystemDb (RLS bypass) on purpose — see the design note
// at the top of this file. Safe to call from any surface (handlers, server
// actions, webhooks, bootstrap) without constructing anything.
// ---------------------------------------------------------------------------

let _registryInserter: AuditInsertFn | null = null;

/** The process-wide audit inserter, lazily constructed on first emit. */
function registryInserter(): AuditInsertFn {
  return (_registryInserter ??= makeSecurityEventInserter());
}

/**
 * Fire-and-forget emit of one audit row through the shared inserter. The audit
 * write never blocks or fails the caller (errors go to stderr via
 * recordSecurityEvent). This is the canonical way to record a privileged
 * mutation — prefer it over constructing an inserter by hand.
 */
export function emitSecurityEvent(event: SecurityEventInput): void {
  recordSecurityEvent(registryInserter(), event);
}

/**
 * Awaitable emit for the rare caller that needs the audit row durably written
 * before proceeding (tests, or evidence-load-bearing paths).
 */
export function emitSecurityEventAsync(
  event: SecurityEventInput,
): Promise<void> {
  return recordSecurityEventAsync(registryInserter(), event);
}
