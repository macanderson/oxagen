// Viewer contexts for unit and component tests (ARCHITECTURE.md §3.1, §5). The
// import graph lets only tests import this module, and knip keeps it out of the
// production graph. Call it with the class to mint and that class's fields:
// `unsafeMint(WsCtx, { … })`.
import { MINT } from "./viewer-mint";

type Minter<F, C> = { mint: (token: typeof MINT, f: F) => C };

export function unsafeMint<F, C>(ctx: Minter<F, C>, fields: NoInfer<F>): C {
  return ctx.mint(MINT, fields);
}
