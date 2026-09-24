// The Fleet page's public surface. The route imports from here; nothing else
// reaches into the folder (eslint: `@/features/*/*` is restricted).
//
// The shell's approvals drawer takes `ApprovalsPanel` from `./client`, and the
// Run page opens that drawer rather than drawing the cards itself. Fleet draws
// no approvals panel (fleet.md): its "Waiting on a human" tile opens the drawer.
export { Fleet } from "./fleet";
export { FleetLoading } from "./loading";
