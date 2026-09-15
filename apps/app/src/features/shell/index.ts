// The shell's public surface (lane L3). Layouts import from here; nothing else
// reaches into the folder (eslint: `@/features/*/*` is restricted).
//
// Server entries: the organization layout renders <ShellFrame> with
// <ShellChrome ctx>, handing it the context it resolved. The workspace layout
// resolves its viewer itself and renders nothing from here.
export { ShellChrome } from "./shell-chrome";
export { ShellFrame } from "./shell-frame";
