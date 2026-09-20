// The Repositories page's public surface (MC spec §10.1, §10.2). The route
// imports from here; nothing else reaches into the folder (eslint:
// `@/features/*/*` is restricted).
export { Repositories } from "./repositories";
export { parseRepositoryTab } from "./view";
