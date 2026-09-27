// not-built.ts: what every module stub throws until its lane builds it.
//
// Lane M0 fixes the signatures. Each later lane replaces one stub's body, and
// the test that checks the stub throws is deleted with it.

/** A call to a module whose lane has not built it yet. */
export class NotBuiltError extends Error {
  readonly module: string;

  constructor(module: string) {
    super(`${module} is not built`);
    this.name = "NotBuiltError";
    this.module = module;
  }
}

/** Throw for a synchronous stub. The arguments are named only to keep the signature. */
export function notBuilt(module: string, ..._args: unknown[]): never {
  throw new NotBuiltError(module);
}

/** Reject for an asynchronous stub. */
export function notBuiltAsync(
  module: string,
  ..._args: unknown[]
): Promise<never> {
  return Promise.reject(new NotBuiltError(module));
}
