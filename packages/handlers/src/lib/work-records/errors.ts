// errors.ts: a work record refusal as the kernel's surfaces read it (P1-04).
//
// The store and @oxagen/work/records refuse with a WorkRecordError. The
// surfaces classify only a HandlerError (forbidden, not_found, conflict) and a
// CapabilityError (invalid_input), so an unmapped WorkRecordError reaches a
// client as a 500. Every Work handler passes its errors through
// `asCapabilityRefusal`, which keeps the work code as the HandlerError reason,
// so a client can tell a stale read (`stale_version`, `stale_head`) apart from
// a state that forbids the action (`not_allowed`) without parsing the message.
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { isWorkRecordError, type WorkRecordErrorCode } from "@oxagen/work/records";

const CONFLICT_CODES: ReadonlySet<WorkRecordErrorCode> = new Set([
  "stale_version",
  "stale_revision",
  "stale_brief",
  "stale_head",
  "not_allowed",
  "conflict",
]);

/**
 * The refusal a surface understands for a work record error, or the error
 * itself when it is not one. Pure.
 */
export function asCapabilityRefusal(capability: string, error: unknown): unknown {
  if (!isWorkRecordError(error)) return error;
  if (error.code === "invalid_input") return new CapabilityError(capability, "invalid_input", error.message);
  if (error.code === "forbidden") return new HandlerError({ code: "forbidden", reason: "forbidden", message: error.message });
  if (error.code === "not_found") return new HandlerError({ code: "not_found", reason: "not_found", message: error.message });
  if (CONFLICT_CODES.has(error.code)) return new HandlerError({ code: "conflict", reason: error.code, message: error.message });
  return error;
}

/** Run `fn`, and rethrow a work record refusal in the shape the surfaces read. */
export async function refusingAs<T>(capability: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw asCapabilityRefusal(capability, error);
  }
}
