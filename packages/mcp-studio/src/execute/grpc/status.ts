// status.ts: gRPC status codes by name (grpc/doc/statuscodes.md).

/** Each status code's name, indexed by the code. */
const STATUS_NAMES = [
  "OK",
  "CANCELLED",
  "UNKNOWN",
  "INVALID_ARGUMENT",
  "DEADLINE_EXCEEDED",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED",
  "FAILED_PRECONDITION",
  "ABORTED",
  "OUT_OF_RANGE",
  "UNIMPLEMENTED",
  "INTERNAL",
  "UNAVAILABLE",
  "DATA_LOSS",
  "UNAUTHENTICATED",
] as const;

export const STATUS_OK = 0;
export const STATUS_CANCELLED = 1;
export const STATUS_DEADLINE_EXCEEDED = 4;
export const STATUS_INTERNAL = 13;
export const STATUS_UNAVAILABLE = 14;

/** The name of a status code, such as UNAVAILABLE for 14. A code outside 0 to 16 reads as UNKNOWN. */
export function statusName(code: number): string {
  return STATUS_NAMES[code] ?? "UNKNOWN";
}
