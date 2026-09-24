// The Fleet page's public surface. The route imports from here; nothing else
// reaches into the folder (eslint: `@/features/*/*` is restricted).
//
// `ApprovalsPanel` is exported because the Run page draws the approval cards
// recorded on one run (#3286 gave `agent.approval_requests` its `run_id`, and
// `list_approvals` filters on it), and the shell's approvals drawer draws the
// same card. One component, so an approval and its mandate bar read the same
// wherever it is decided. Fleet itself draws no approvals panel (fleet.md):
// its "Waiting on a human" tile opens the drawer.
export { Fleet } from "./fleet";
export { FleetLoading } from "./loading";
export { ApprovalsPanel } from "./approvals-panel";
