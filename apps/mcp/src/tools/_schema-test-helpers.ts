import { z } from "zod";

/**
 * Wrap an xmcp tool's `schema` export (a `Record` of Zod field schemas) into a
 * parseable `z.object` for unit assertions. Generic over the raw shape so the
 * precise output type is preserved — parsed results stay fully typed rather than
 * collapsing to `any`. Shared across every `*.schema.test.ts` so there is a
 * single definition to maintain.
 */
export function obj<T extends z.ZodRawShape>(schema: T) {
  return z.object(schema);
}
