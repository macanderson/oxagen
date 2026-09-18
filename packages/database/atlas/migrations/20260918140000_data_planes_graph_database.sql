-- ADR-091 / spec §5.3: an organisation's graph lives in its OWN Neo4j database
-- on the platform cluster once an OrgGraphProvisioner has created it.
--
-- `graph_database` names that database (`org-<namespace>`). It rides on a
-- SHARED-mode `neo4j` binding — same cluster, same credential, its own database
-- — so the resolver keeps one row per (organisation, store) and every store
-- client keeps asking one question. NULL means the POOLED database: free and
-- trial organisations, scoped by property. A DEDICATED plane names its database
-- inside the encrypted config instead, so the column is refused there.
--
-- The CHECK mirrors Neo4j's database-name grammar (an ASCII letter first, then
-- lowercase letters, digits, dots or dashes, 3–63 characters) and the org-
-- prefix, so a row can never route a session to `system` or to the pool.
ALTER TABLE "org"."data_planes"
  ADD COLUMN "graph_database" text NULL;

ALTER TABLE "org"."data_planes"
  ADD CONSTRAINT "data_planes_graph_database_check" CHECK (
    "graph_database" IS NULL
    OR (
      "kind" = 'neo4j'
      AND "mode" = 'shared'
      AND "graph_database" ~ '^org-[a-z0-9]{2,6}$'
    )
  );
