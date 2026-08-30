// Shared `no-restricted-imports` config that bans the raw data-store seam
// clients outside their owning packages. Every tenant data access must go
// through a scope-aware wrapper so Row-Level Security stays load-bearing:
//   - Postgres:   withTenantDb (scoped) / withSystemDb (explicit, audited bypass)
//   - Neo4j:      scopedSession()
//   - ClickHouse: chInsert / chSelect
// Imported by both the root config (non-Next packages + apps/api, apps/mcp) and
// the Next config (apps/app, …) so enforcement cannot drift. (OXA-1515)
//
// Every seam must be banned on BOTH the package barrel AND the subpath that
// actually defines/re-exports the raw client — otherwise the deep import is a
// one-line bypass of the whole rule. When a package gains a new subpath export
// that reaches a raw client, add it here in the same commit.
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
      // `driver` is banned alongside `session`: driver().session() hands back
      // the same unscoped Neo4j session, so banning only `session` leaves the
      // seam open to a one-word rename at the call site.
      name: "@oxagen/ontology",
      importNames: ["driver", "session"],
      message:
        "Raw session()/driver() bypasses tenant scope. Use scopedSession() " +
        "from @oxagen/ontology. (OXA-1515)",
    },
    {
      // session()/driver() are defined in packages/ontology/src/client.ts, so
      // this subpath reaches them without going through the barrel. Banning
      // only the barrel above would leave the seam trivially bypassable.
      name: "@oxagen/ontology/client",
      importNames: ["driver", "session"],
      message:
        "Raw session()/driver() bypasses tenant scope. Use scopedSession() " +
        "from @oxagen/ontology. (OXA-1515)",
    },
    {
      name: "@oxagen/telemetry",
      importNames: ["clickhouse"],
      message:
        "Raw clickhouse() bypasses tenant scoping. Use chInsert / chSelect from " +
        "@oxagen/telemetry. (OXA-1515)",
    },
    {
      // Same hole as @oxagen/ontology/client: packages/telemetry/src/client.ts
      // re-exports clickhouse, so the barrel ban alone is not enforcement.
      name: "@oxagen/telemetry/client",
      importNames: ["clickhouse"],
      message:
        "Raw clickhouse() bypasses tenant scoping. Use chInsert / chSelect from " +
        "@oxagen/telemetry. (OXA-1515)",
    },
  ],
};
