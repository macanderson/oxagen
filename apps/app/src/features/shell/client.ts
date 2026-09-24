"use client";

// The shell's public client entry. A client component in another lane imports
// from here, never from the server barrel: `@/features/shell` re-exports the
// landing redirect and the export route, which reach the database, and a
// client import of the barrel puts those modules in the browser bundle. The
// drawer's event lives in `@/shared/approvals-drawer`, which a page may also
// import directly.
export { openApprovals } from "@/shared/approvals-drawer";
// The lists the record pickers offer, read the first time a picker opens.
export {
  chooseAgents,
  chooseApprovers,
  chooseModels,
  chooseSwitchTargets,
  chooseToolPatterns,
} from "./choice-actions";
/**
 * Bisect's other run. Its only reader is `features/run/replay-actions.tsx`,
 * which knip holds out of the production graph, so this re-export carries the
 * tag its definition in `choice-actions.ts` already carries. A tag on the
 * definition alone does not reach a re-export.
 * @deregistered Retained with the replay UI under ADR-130.
 */
export { chooseRuns } from "./choice-actions";
