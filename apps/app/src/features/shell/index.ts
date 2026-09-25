// The shell's public surface (lane L3). Layouts import from here; nothing else
// reaches into the folder (eslint: `@/features/*/*` is restricted).
//
// Server entries: the organization layout renders <ShellFrame> with
// <ShellChrome ctx>, handing it the context it resolved, and wraps its pages in
// <ViewerClock ctx> so every date renders in the person's zone. The workspace
// layout resolves its viewer itself and renders nothing from here. The root
// page renders <Landing>, which redirects to the viewer's first workspace.
export { Landing } from "./landing";
export { ShellChrome } from "./shell-chrome";
export { ShellFrame } from "./shell-frame";
export { ViewerClock } from "./viewer-clock";
// The workspace layout renders it: the sidebar's counts and the bell's feed for
// the workspace in the URL, published to the chrome.
export { ShellWorkspace } from "./workspace-activity";
// The workspace layout renders it in place of the page for a workspace the
// viewer cannot see, so the shell stays around the refusal.
export { WorkspaceDenied } from "./workspace-denied";
// Rendered by a page, not a layout: the record it is showing, so the assistant
// is asked about what is on screen rather than about what the URL implies.
export { PageRecord } from "./page-record";
// The account export download route is a route handler rather than a page, so
// it has no component to render, but it is still outside this lane and reaches
// it through the same surface: the handler that streams the archive, and the
// read that says whether the export is ready.
export { readExportStatus } from "./account-actions";
export { handleExportDownload } from "./export-download";
export { readExportObject } from "./export-storage";
// The flyout's Stop control posts to a route handler, not a server action,
// because the question it stops is itself a pending action (#4164): the
// handler that gates the stop, and the action that asks the kernel for it.
export { stopAssistantTurn } from "./assistant-actions";
export { handleAssistantStop } from "./assistant-stop";
