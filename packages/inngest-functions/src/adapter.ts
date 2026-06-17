/**
 * Adapter bridging the @oxagen/functions provider-agnostic interfaces to
 * the concrete Inngest SDK implementation.
 *
 * Product code does not need to change yet - this file exists so consumers
 * can opt-in to the abstract EventClient type during migration.
 */
import type { EventClient, EventPayload } from "@oxagen/functions";
import { NonRetriableError } from "@oxagen/functions";
import { inngest } from "./inngest";

// ─── EventClient adapter ─────────────────────────────────────────────────────

/**
 * Creates an EventClient backed by the Inngest lazy proxy.
 *
 * The wrapper ensures the return type matches the abstract contract
 * (Promise<void>) regardless of what the Inngest SDK returns.
 */
export function createEventClient(): EventClient {
  return {
    async send(event: EventPayload | EventPayload[]): Promise<void> {
      // Inngest's send() accepts the same { name, data } shape.
      // Cast is safe because EventPayload is structurally a subset of the
      // Inngest event schema (any { name: string, data: unknown } is accepted).
      await inngest.send(event as Parameters<typeof inngest.send>[0]);
    },
  };
}

// ─── Re-exports ──────────────────────────────────────────────────────────────

export { NonRetriableError };
export { createFunction } from "./create-function";
export type { EventClient } from "@oxagen/functions";
