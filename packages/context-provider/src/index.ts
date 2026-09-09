/**
 * `@oxagen/context-provider` — oxagen's Context Exchange Provider.
 *
 * Serves one workspace's engram memory as Context Graph Protocol frames. See
 * `provider.ts` for what it declares at handshake and why each declaration is
 * true, and `README.md` for how to run it.
 */
export {
  createContextProvider,
  PROVIDER_NAME,
  type ContextProviderOptions,
} from "./provider";
export { packWithinBudget, type BudgetLimits } from "./budget";
export {
  contentDigest,
  frameProvenance,
  frameTitle,
  frameUri,
  renderContent,
  toFrame,
  FRAME_URI_SCHEME,
} from "./frames";
export { frameKindOf, recordKindsFor, SERVED_FRAME_KINDS } from "./kinds";
