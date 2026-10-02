// The Work area's public surface (agent-work-phase-1.html, Screens): the Work
// page with its four tabs, one work item, Work setup, and Outcomes. The routes
// import from here; nothing else reaches into the folder (eslint:
// `@/features/*/*` is restricted).
export { WorkItemLoading, WorkLoading } from "./loading";
export { WorkItemPage } from "./item/work-item-page";
export { WorkOutcomesPage } from "./outcomes/outcomes-page";
export { WorkSetupPage } from "./setup/setup-page";
export { parseSetupTab, parseWorkTab } from "./tabs";
export { WorkPage } from "./work-page";
