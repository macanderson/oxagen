export * from "./client";
export * from "./types";
export * from "./labels";
export { migrate as migrateNeo4j } from "./migrate";
export { scopedSession } from "./tenant";
// ADR-042 dedicated-plane driver lifecycle (rotation + shutdown).
export {
  closeDedicatedDrivers,
  dedicatedDriverCount,
  evictOrgDrivers,
  MAX_DEDICATED_DRIVERS,
} from "./data-plane-driver";
export { GraphScopeError } from "./graph-scope";
export type { GraphScope } from "./graph-scope";
export {
  oversampledLimit,
  DEFAULT_OVERSAMPLE_FACTOR,
  DEFAULT_OVERSAMPLE_CAP,
  SCOPE_OVERSAMPLE_FACTOR,
} from "./ann";
// Organisation graph provisioning (spec §5.3, ADR-098).
export {
  createAuraProvisioner,
  createCypherProvisioner,
  createPooledProvisioner,
  CREATE_ORG_DATABASE_CYPHER,
  OrgGraphProvisionError,
  OrgGraphProvisionerNotConfigured,
  provisionOrgGraph,
  selectOrgGraphProvisioner,
} from "./provision";
export type {
  CypherProvisionerDeps,
  OrgGraphPlacement,
  OrgGraphProvisioner,
  OrgGraphProvisionerKind,
  OrgGraphSubject,
} from "./provision";
export {
  isOrgGraphDatabaseName,
  listOrgGraphDatabases,
  ORG_GRAPH_DATABASE_PREFIX,
  OrgGraphNameError,
  orgGraphDatabaseName,
} from "./org-graph";
