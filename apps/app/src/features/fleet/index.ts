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
// The route reads the saved table choice from its cookie and the filter from
// its URL, so Fleet's first render already draws what the person chose.
export {
  FLEET_PREFS_COOKIE,
  pullRequestFilterOf,
  readFleetPrefs,
} from "./prefs";
export { FleetLoading } from "./loading";
export { ApprovalsPanel } from "./approvals-panel";
// The approvals drawer draws one card alone, with no panel heading around it,
// so the drawer keeps one "Approvals" heading and the card its full width.
export { ApprovalCardAlone } from "./approvals-panel";
// The Run page's not-loaded states offer the same Try again, Open an
// incident and Request access as Fleet's, so both read one set of dialogs.
export { OpenIncident, RequestAccess, TryAgain } from "./state-actions";
