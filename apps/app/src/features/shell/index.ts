// The shell's public surface (lane L3). Layouts import from here; nothing else
// reaches into the folder (eslint: `@/features/*/*` is restricted).
//
// Server entries: the organization layout renders <ShellFrame> with
// <ShellChrome>; the workspace layout renders <WorkspaceGuard>.
export { ShellChrome, WorkspaceGuard } from "./shell-chrome";
export { ShellFrame } from "./shell-frame";

// The phone navigation seam (feedback 3, plan §6 Q3): the design replaces the
// body of <MobileNav> and keeps its props.
export { MobileNav, type MobileNavProps } from "./mobile-nav";
