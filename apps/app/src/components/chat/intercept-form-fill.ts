"use client";
/**
 * intercept-form-fill.ts
 *
 * Transparent async-generator interceptor that fires callbacks when
 * `page_form_fill` tool events pass through the SSE stream.
 *
 * Extracted from chat-shell-client.tsx so it can be unit-tested in isolation.
 */

import type { StreamEvent } from "./stream-event-types";
import type { FormFillResult } from "@/lib/ask/fill-types";

/** Raw shape of a page_form_fill tool output returned by the server. */
export interface PageFormFillOutput {
  fields: Array<{
    name: string;
    current: unknown;
    proposed: unknown;
    changed: boolean;
    reason?: string;
  }>;
}

/**
 * Yields every event unchanged while intercepting `page_form_fill` tool events:
 *
 * - `tool-call-start` with `capability === "page_form_fill"` → calls `onStart()`.
 * - `tool-call-end` for a tracked fill tool-call (status "completed") with a
 *   valid fields array → calls `onEnd(result)`.
 *
 * Both callbacks are optional and never throw — the stream always continues.
 */
export async function* interceptFormFillEvents(
  source: AsyncGenerator<StreamEvent>,
  onStart: (() => void) | null,
  onEnd: ((result: FormFillResult) => void) | null,
): AsyncGenerator<StreamEvent> {
  // Track tool-call IDs that belong to page_form_fill so we can match the end.
  const fillToolCallIds = new Set<string>();

  for await (const event of source) {
    if (
      event.type === "tool-call-start" &&
      event.capability === "page_form_fill"
    ) {
      fillToolCallIds.add(event.toolCallId);
      onStart?.();
    } else if (
      event.type === "tool-call-end" &&
      fillToolCallIds.has(event.toolCallId) &&
      event.status === "completed" &&
      event.output !== null &&
      event.output !== undefined
    ) {
      fillToolCallIds.delete(event.toolCallId);
      // Validate output shape before forwarding to the callback.
      const out = event.output as PageFormFillOutput;
      if (Array.isArray(out?.fields)) {
        const fillResult: FormFillResult = {
          fields: out.fields.map((f) => ({
            name: f.name,
            current: f.current,
            proposed: f.proposed,
            changed: f.changed,
            ...(typeof f.reason === "string" ? { reason: f.reason } : {}),
          })),
        };
        onEnd?.(fillResult);
      }
    }
    yield event;
  }
}
