// The creation wizards' public surface (roadmap creation-spec §1-§2). The
// workspace layout renders <CreateHost> once; every entry point opens it
// through `openCreate` in `@/shared/create`. The pure path helpers are public
// too, so the record page names the same file and branch the wizard does
// (#4765).
export { CreateHost } from "./create-host";
export { branchFor, recordPathFor } from "./record-file";
