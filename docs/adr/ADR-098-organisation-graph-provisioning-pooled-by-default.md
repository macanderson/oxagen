# ADR-098: Organisation graphs are placed by one provisioning interface, and pooled is the default

- **Status:** Accepted
- **Date:** 2026-09-18
- **Owners:** knowledge, platform
- **Related:** Mission Control spec §5.3 (Neo4j: one database per organization)
  and §17 (M0 acceptance), ADR-042 (data planes), ADR-087 (the tenancy seam
  constructs scoping rather than validating it), #3199, #2949,
  `packages/ontology/src/provision.ts`, `packages/ontology/src/org-graph.ts`,
  `packages/ontology/src/tenant.ts`,
  `packages/ontology/integration/tenant-isolation.test.ts`

## Context

Spec §5.3 makes the database the tenant boundary on the graph. Each paid
organisation gets its own Neo4j database, and a query cannot cross databases
without a composite database, which Oxagen never creates. Free and trial
organisations stay in one pooled database, scoped by property, because Aura
caps an instance at 100 databases and provisioning on signup would spend that
cap on empty tenants (rule 3). Rule 1 puts the Aura API path and the
self-managed Cypher path behind one provisioning interface.

M0's acceptance line is "a cross-tenant probe finds nothing in either store."
Postgres had its probe (`packages/database/integration/rls.test.ts`). The graph
had none, and no code created a database for anyone.

Three facts constrain what this repository can prove today:

- Dev and CI run `neo4j:5.24-community`. Community Edition has one user
  database and refuses `CREATE DATABASE`.
- No Aura instance with multiple databases enabled exists, and no credential
  for the Aura API exists to test an implementation against.
- Every organisation in production today is in the pooled database.

## Decision

### 1. One interface, three implementations

`OrgGraphProvisioner` has one method, `provision({ orgId, namespace })`, which
returns a placement: `{ mode: "pooled" }` or `{ mode: "database", database }`.
Repeating it is safe.

- **`pooled`** creates nothing and places the organisation in the pooled
  database.
- **`cypher`** runs `CREATE DATABASE $name IF NOT EXISTS WAIT` against
  `system`, with the name as a parameter, then applies the graph schema to the
  new database. It is for self-managed Enterprise.
- **`aura`** throws `OrgGraphProvisionerNotConfigured`. See decision 4.

`selectOrgGraphProvisioner` picks one. Free and trial plans get `pooled`
whatever the deployment runs. A paid plan gets the provisioner named by
`NEO4J_ORG_PROVISIONER`, which defaults to `pooled`. An unrecognised value is
refused, not defaulted.

Organisation creation (`packages/handlers/src/org.create.ts`) is the one call
site. When the placement is a database, it writes the routing row on the same
Postgres transaction as the organisation: `org.data_planes.graph_database` on a
shared-mode `neo4j` binding. A provisioning failure rolls the organisation
back. Nothing falls back to the pool, because a paid organisation silently left
in the pool is the isolation downgrade the spec forbids.

`scopedSession()` reads the binding on its first `run()`. A null
`graph_database` opens the pooled database. A named one opens that database on
the platform cluster.

### 2. The database is named `org-<namespace>`

The spec writes `org_<namespace>`. Neo4j refuses an underscore in a database
name: the first character is an ASCII letter, the rest are lowercase letters,
digits, dots, or dashes. So the separator is a dash. The namespace is the
organisation's immutable handle, not its renameable slug, so the name holds for
the organisation's life. A Postgres `CHECK` on the column mirrors the grammar,
so no row can route a session to `system` or to the pool by name.

### 3. Pooled is the default, and the proof is split by edition

Pooled is the default for free and trial organisations by rule, and for every
organisation until a deployment sets `NEO4J_ORG_PROVISIONER=cypher`. It is the
only placement Community Edition can run.

Each path is proven where it can be:

| Path | Proven by | Against |
| --- | --- | --- |
| Pooled isolation | `integration/tenant-isolation.test.ts` | a real Neo4j, in CI |
| Cypher provisioner, per-org routing | `provision.test.ts`, `tenant.data-plane.test.ts`, `org.create.test.ts`, `data-plane-resolver.test.ts` | mocks |
| Community refuses `CREATE DATABASE`, typed | `integration/tenant-isolation.test.ts` | a real Neo4j, in CI |

The integration probe seeds three tenants through `scopedSession` (org A
workspace A1, org A workspace A2, org B workspace B1), reads from A1 with the
query shapes production uses, and asserts that nothing from B1 or A2 comes
back. It skips only when `NEO4J_URI` is absent and throws if it would skip in
CI. It runs in the `rls-integration` job, beside the Postgres probe.

The per-organisation database path has never run against an engine that
supports it. That is the gap this split leaves, and it closes when a
self-managed Enterprise instance exists to run the probe against.

### 4. Aura is refused until an instance exists

`createAuraProvisioner()` throws a typed error naming this ADR. Aura creates
databases only through its API, and the multiple-databases setting must be
chosen when the instance is created and cannot be changed later. Writing a
client for an API nobody here has called would ship an untested path on the
isolation boundary. When an instance and a credential exist, the Aura
provisioner is written against them and the probe runs against it.

### 5. Every row-selecting pattern carries its own anchor

Running the probe's reads raw showed the seam's query-wide anchor was not
enough in the pooled database. `MATCH (a:GraphNode {orgId: $orgId}) MATCH
(b:GraphNode) RETURN b` returns every tenant's nodes. ADR-087 recorded that
query as accepted. The seam now refuses it.

`assertAnchorsTenant` keeps the query-wide check and adds one per pattern.
Every comma-separated pattern part of every `MATCH` and `OPTIONAL MATCH`
clause, at every subquery level, must be anchored in one of three ways: its own
pattern map binds `$orgId`, its clause's `WHERE` binds `$orgId` on a variable
written in the part, or it names a variable an earlier anchored part bound. The
credit resets at each top-level `UNION` branch.

That closes the second unanchored `MATCH`, the unanchored `OPTIONAL MATCH`, the
unanchored `UNION` branch, the `MATCH` after an anchoring `MERGE`, the comma
Cartesian product, and the map-alias tautology ADR-087 listed under Claim B.
It rejects 0 of the production queries the corpus test collects, after one
change: `ontology.query` now writes its traversal's node patterns literally
rather than interpolating them.

It is still a syntactic rule. Two forms stay accepted and are recorded in
`tenant.scope-guard.test.ts`. A traversal leaving an anchored node reaches
whatever its edges reach, and crosses tenants only over a cross-tenant edge.
Writing one through the seam now needs a `MATCH` on the other tenant's node,
which the rule refuses, and the probe asserts the traversal stays inside the
organisation. A `WHERE` anchor inside an `OR` is credited. #3199, constructing
the scoping instead of validating it, remains the fix for the class.

## Consequences

- A paid organisation on a deployment running `cypher` gets its own database at
  creation, and every later session routes to it with no query change.
- A paid organisation on a deployment running `aura` cannot be created until
  the Aura provisioner exists. That is deliberate.
- Moving a free organisation to its own database on upgrade (rule 3's export
  and import) is not built. Until it is, an upgraded organisation stays pooled.
- Workspace isolation inside an organisation is a query predicate, not a seam
  property. The seam injects `$workspaceId` but requires only the `$orgId`
  anchor. Spec §5.3 asks workspace-scoped sessions to refuse Cypher that does
  not bind the workspace. That is not done here, and the probe shows an
  organisation-wide read sees both of its workspaces.
- A query that previously passed the seam with one anchored pattern and one
  unanchored pattern now throws `TenantScopeError` naming the pattern.

## Alternatives considered

- **Provision a database for every organisation at signup.** Spends the Aura
  cap on empty tenants (spec §5.3 rule 3).
- **Fall back to the pool when provisioning fails.** Places a paid
  organisation below the isolation it paid for, silently.
- **Name the database `org_<namespace>` as written.** The engine refuses it.
- **Run Enterprise in CI to prove the per-org path against an engine.** Needs a
  licence this repository does not carry. The split in decision 3 is the
  honest record until one exists.
