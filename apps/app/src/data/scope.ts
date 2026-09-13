// The tenant a read runs under. Lane L4 owns the type (src/server/tenant-scope.ts,
// a pure module); the data layer re-exports it so ports and adapters name one
// Scope without importing the session and navigation seams.
import { ORG_ONLY_WS } from "@/server/tenant-scope";

export type { Scope } from "@/server/tenant-scope";

/** The workspace id organization-scoped pages carry. */
export const ORG_ONLY_WORKSPACE_ID = ORG_ONLY_WS;
