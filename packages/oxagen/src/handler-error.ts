// HandlerError — the typed refusal a capability handler throws.
//
// A handler refuses for one of three reasons: the actor may not do this
// (forbidden), the thing the input names is not in this tenant (not_found), or
// the write would leave the tenant in a state the domain forbids (conflict —
// the last owner, an already-resolved approval). The kernel rethrows what a
// handler throws (kernel.ts, the catch after the handler call), so the surface
// on the other side classifies by `code`: the API middleware maps the three
// codes to 403, 404 and 409 (apps/api/src/middleware/error.ts) and the app's
// kernel seam maps them to `denied`, `not_found` and `conflict`
// (apps/app/ARCHITECTURE.md §3.2). `reason` is the stable machine sub-code a
// client keys on (`last_owner`, `approval_expired`); `message` is for a human.
//
// The class lives in @oxagen/oxagen so packages/handlers and packages/agent
// both throw the one class without depending on each other.

export const HANDLER_ERROR_CODES = [
  "forbidden",
  "not_found",
  "conflict",
] as const;
export type HandlerErrorCode = (typeof HANDLER_ERROR_CODES)[number];

export class HandlerError extends Error {
  readonly code: HandlerErrorCode;
  readonly reason: string;

  constructor(opts: {
    code: HandlerErrorCode;
    reason: string;
    message?: string;
  }) {
    super(opts.message ?? `${opts.code}: ${opts.reason}`);
    this.name = "HandlerError";
    this.code = opts.code;
    this.reason = opts.reason;
  }
}

/**
 * Shape guard, keyed on `code` and `reason` rather than `instanceof`, so a
 * surface whose module graph holds a second copy of this file (vitest mocks,
 * a bundler duplicating a workspace package) still classifies the refusal.
 */
export function isHandlerError(err: unknown): err is HandlerError {
  if (!(err instanceof Error)) return false;
  const { code, reason } = err as Partial<HandlerError>;
  return (
    typeof reason === "string" &&
    (HANDLER_ERROR_CODES as readonly string[]).includes(code as string)
  );
}
