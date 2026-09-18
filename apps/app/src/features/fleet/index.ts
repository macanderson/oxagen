// The Fleet page's public surface. The route imports from here; nothing else
// reaches into the folder (eslint: `@/features/*/*` is restricted).
//
// `ApprovalsPanel` is exported because the Run page's Policy tab draws the
// same cards over one run's approvals (WL-35). Sharing the component is what
// keeps an approval, and its mandate bar, reading the same on both pages.
export { ApprovalsPanel } from "./approvals-panel";
export { Fleet } from "./fleet";
