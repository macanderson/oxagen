// The creation wizards' public surface (roadmap creation-spec §1-§2). The
// workspace layout renders <CreateHost> once; every entry point opens it
// through `openCreate` in `@/shared/create`, never by importing this folder.
export { CreateHost } from "./create-host";
