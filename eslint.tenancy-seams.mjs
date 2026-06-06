// Shared `no-restricted-imports` config that bans the raw data-store seam
// clients outside their owning packages. Every tenant data access must go
// through a scope-aware wrapper so Row-Level Security stays load-bearing:
//   - Postgres:   withTenantDb (scoped) / withSystemDb (explicit, audited bypass)
//   - Neo4j:      scopedSession()
//   - ClickHouse: chInsert / chSelect
// Imported by both the root config (non-Next packages + apps/api, apps/mcp) and
// the Next config (apps/app, …) so enforcement cannot drift. (OXA-1515)
export const tenancySeamRestrictedImports = {
  paths: [
    {
      name: "@oxagen/database",
      importNames: ["db"],
      message:
        "Raw db() bypasses tenant RLS scoping. Use withTenantDb (scoped) or " +
        "withSystemDb (explicit, audited bypass) from @oxagen/database. (OXA-1515)",
    },
    {
      name: "@oxagen/database/client",
      importNames: ["db"],
      message:
        "Raw db() bypasses tenant RLS scoping. Use withTenantDb / withSystemDb " +
        "from @oxagen/database. (OXA-1515)",
    },
    {
      name: "@oxagen/ontology",
      importNames: ["session"],
      message:
        "Raw session() bypasses tenant scope. Use scopedSession() from " +
        "@oxagen/ontology. (OXA-1515)",
    },
    {
      name: "@oxagen/telemetry",
      importNames: ["clickhouse"],
      message:
        "Raw clickhouse() bypasses tenant scoping. Use chInsert / chSelect from " +
        "@oxagen/telemetry. (OXA-1515)",
    },
  ],
};
