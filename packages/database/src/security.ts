// packages/database/src/security.ts
//
// Factory that wires the @oxagen/telemetry AuditInsertFn to the Drizzle
// database client. Callers (API bootstrap, MCP bootstrap, auth hooks) call
// makeSecurityEventInserter(db()) once and pass the resulting fn to
// setSecurityEventEmitter or directly to recordSecurityEvent.
//
// This file is the ONLY place in @oxagen/database that couples to the
// @oxagen/telemetry type contract — keeping the coupling explicit and
// locatable.

import type { AuditInsertFn, SecurityEventInput } from "@oxagen/telemetry";
import type { Database } from "./client.js";
import { schema } from "./index.js";

/**
 * Returns an AuditInsertFn bound to the given Drizzle database instance.
 * Wire the result into the kernel emitter or pass it directly to
 * recordSecurityEvent / recordSecurityEventAsync from @oxagen/telemetry.
 *
 * @example
 * ```ts
 * import { db } from "@oxagen/database/client";
 * import { makeSecurityEventInserter } from "@oxagen/database/security";
 * import { setSecurityEventEmitter, recordSecurityEvent } from "@oxagen/telemetry";
 *
 * // Surface bootstrap (API server, MCP server):
 * const insert = makeSecurityEventInserter(db());
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
export function makeSecurityEventInserter(database: Database): AuditInsertFn {
  return async (event: SecurityEventInput): Promise<void> => {
    await database.insert(schema.securityEvents).values({
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
    });
  };
}
