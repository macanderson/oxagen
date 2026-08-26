// @oxagen/plugins/registry — MCP registry client, catalog mapping, and README
// rendering. `listServers`/`getServerVersion` hit the registry LIVE over HTTP;
// the periodic upsert into mcp.catalog_servers lives in ../catalog-sync.ts.
export { listServers, getServerVersion } from "./registry-client";
export type { ListServersOptions, ListServersResult } from "./registry-client";
export {
  deriveTransportTypes,
  deriveAuthKind,
  mapServerDetailToCatalogRow,
} from "./map-server";
export type { AuthKind, CatalogRowInput } from "./map-server";
export { fetchAndRenderReadme, isReadmeFresh } from "./readme";
export type {
  Icon,
  Repository,
  ServerDetail,
  ServerMeta,
  ServerResponse,
  ListServersResponse,
} from "./types";
