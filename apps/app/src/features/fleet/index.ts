// The Fleet page's public surface. The route imports from here; nothing else
// reaches into the folder (eslint: `@/features/*/*` is restricted).
//
// The shell's approvals drawer takes `ApprovalCardAlone` from here, and the
// Run page opens that drawer rather than drawing the cards itself. Fleet draws
// no approvals panel (fleet.md): its "Waiting on a human" tile opens the drawer.
export { Fleet } from "./fleet";
export { FleetLoading } from "./loading";
// The approvals drawer draws one card alone, with no panel heading around it,
// so the drawer keeps one "Approvals" heading and the card its full width.
export { ApprovalCardAlone } from "./approvals-panel";
