// The Fleet page's public surface. The route imports from here; nothing else
// reaches into the folder (eslint: `@/features/*/*` is restricted).
//
// `ApprovalsPanel` is exported because the Run page draws the same cards over
// the approvals recorded on one run (#3286 gave `agent.approval_requests` its
// `run_id`, and `list_approvals` filters on it). One component, so an approval
// and its mandate bar read the same on Fleet and on the run it was parked in.
export { Fleet } from "./fleet";
export { FleetRegister } from "./fleet-actions";
export { ApprovalsPanel } from "./approvals-panel";
