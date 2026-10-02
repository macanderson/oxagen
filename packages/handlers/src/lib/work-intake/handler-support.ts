// handler-support.ts: what the work intake and triage handlers share (P1-03,
// #5103): the refusal each library error becomes, and the event sender.
//
// A refusal keeps the library's message, which says what went wrong and what
// to do next. The API maps forbidden, not_found, and conflict to 403, 404,
// and 409, and an invalid input to 400.
import { HandlerError } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { TriageCorrectionError } from "@oxagen/work";
import { isWorkRecordError } from "@oxagen/work/records";
import { CollectorSetupError } from "./collectors";

/** The refusal a handler throws for a library error. Anything else is returned unchanged. */
export function workRefusal(capability: string, error: unknown): unknown {
  if (isWorkRecordError(error)) {
    switch (error.code) {
      case "invalid_input":
        return new CapabilityError(capability, "invalid_input", error.message);
      case "forbidden":
        return new HandlerError({ code: "forbidden", reason: "work_forbidden", message: error.message });
      case "not_found":
        return new HandlerError({ code: "not_found", reason: "work_item_not_found", message: error.message });
      default:
        return new HandlerError({ code: "conflict", reason: error.code, message: error.message });
    }
  }
  if (error instanceof TriageCorrectionError) return new CapabilityError(capability, "invalid_input", error.message);
  if (error instanceof CollectorSetupError) {
    if (error.code === "invalid_input") return new CapabilityError(capability, "invalid_input", error.message);
    return new HandlerError({ code: error.code, reason: `collector_${error.code}`, message: error.message });
  }
  return error;
}

/** A work/ event a handler sends after its write commits. */
export interface WorkEvent {
  name: string;
  id?: string;
  data: Record<string, unknown>;
}

/** Send events through the API process's event client. */
export async function sendWorkEvents(events: readonly WorkEvent[]): Promise<void> {
  if (events.length === 0) return;
  const { eventClient } = await import("../../event-client");
  await eventClient.send([...events]);
}

/** A work item that is not in this workspace. */
export function itemNotFound(itemId: string): HandlerError {
  return new HandlerError({
    code: "not_found",
    reason: "work_item_not_found",
    message: `This workspace has no work item ${itemId}.`,
  });
}
