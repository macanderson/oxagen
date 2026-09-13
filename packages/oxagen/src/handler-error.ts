/**
 * A refusal a handler makes on its own facts: the caller's role, a row that
 * is not in the caller's tenant, a state that no longer admits the change.
 *
 * `CapabilityError` is the kernel's: it is thrown before a handler runs (IAM,
 * surface, input shape). `HandlerError` is thrown from inside a handler, after
 * the gates, and leaves the kernel unchanged (`kernel.ts` rethrows). Surfaces
 * classify on `code`, never on the message: the API maps `forbidden` → 403,
 * `not_found` → 404, `conflict` → 409, and the app maps the same three codes
 * to its `denied` / `not_found` / `conflict` results.
 *
 * `reason` is a stable machine token for the specific refusal
 * (`approval_expired`, `run_not_found`), so a test asserts the code and the
 * reason and never the prose.
 */
export const HANDLER_ERROR_CODES = [
  "forbidden",
  "not_found",
  "conflict",
] as const;
export type HandlerErrorCode = (typeof HANDLER_ERROR_CODES)[number];

export class HandlerError extends Error {
  override readonly name = "HandlerError";
  constructor(
    readonly code: HandlerErrorCode,
    readonly reason: string,
    message: string = `${code}: ${reason}`,
  ) {
    super(message);
  }
}

/**
 * Shape check, not `instanceof`: a surface that loaded a second copy of this
 * module (a test mock, a bundler duplicate) still classifies the refusal.
 */
export function isHandlerError(err: unknown): err is HandlerError {
  if (typeof err !== "object" || err === null) return false;
  const { name, code, reason } = err as Record<string, unknown>;
  return (
    name === "HandlerError" &&
    typeof reason === "string" &&
    (HANDLER_ERROR_CODES as readonly unknown[]).includes(code)
  );
}
