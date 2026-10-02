// collectors/modules.ts: the collector modules this build ships.
//
// Each collector lane adds its module here with two lines:
//
//   import * as github from "./github";
//   ...and `github,` in SHIPPED_MODULES below.
//
// registerCollectorModule finds the CollectorDefinition the file exports, so
// the export's name does not matter. A type with no module here has no
// doorbell, fetch, or reconcile. Its inbound events wait unprocessed, and the
// reconcile skips it, until the module ships.
import * as github from "./github";
import { registerCollectorModule } from "./registry";

/** The GitHub Issues collector shipped with Phase 1 of agent work (P1-03, #5103). */
const SHIPPED_MODULES: readonly Record<string, unknown>[] = [github];

/** Register every shipped module. Safe to call more than once. */
export function registerCollectorModules(
  modules: readonly Record<string, unknown>[] = SHIPPED_MODULES,
): void {
  for (const moduleExports of modules) registerCollectorModule(moduleExports);
}
