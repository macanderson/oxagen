// The Fleet page's public surface. The route imports from here; nothing else
// reaches into the folder (eslint: `@/features/*/*` is restricted).
//
// `ApprovalsPanel` stays inside the folder: the Run page's Policy tab would
// have drawn the same cards over one run's approvals (WL-35), but no approval
// row records a run, so that tab is not drawn (#3286) and nothing outside
// Fleet reads the panel yet. Export it again when the tab returns, so an
// approval and its mandate bar keep reading the same on both pages.
export { Fleet } from "./fleet";
