/**
 * Graph tenant isolation, against a real Neo4j (M0 — spec §5.3 and §17:
 * "A cross-tenant probe finds nothing in either store").
 *
 * `packages/database/integration/rls.test.ts` is the Postgres half of that
 * sentence. This is the graph half. It seeds three tenants through the seam
 * every production write goes through (`scopedSession`), then reads from one of
 * them through the same seam with the query shapes production uses, and asserts
 * that nothing from the other two comes back:
 *
 *   A1  org A, workspace A1 — the caller
 *   A2  org A, workspace A2 — same organisation, another workspace
 *   B1  org B, workspace B1 — another organisation
 *
 * It runs against the POOLED database: every tenant in one database, scoped by
 * property. That is where every organisation lives today (free and trial by
 * rule, paid by default until a deployment runs `NEO4J_ORG_PROVISIONER=cypher`),
 * and it is the only placement Community Edition — dev and CI — can run. The
 * per-organisation database path is proven by unit tests (`provision.test.ts`,
 * `tenant.data-plane.test.ts`); this file adds the one real-engine fact about
 * it that Community can give, that the engine refuses `CREATE DATABASE` and
 * the Cypher provisioner surfaces that as a typed error. ADR-091 records the
 * split.
 *
 * The file also runs three queries the seam REFUSES through a raw driver session,
 * to prove the refusal is load-bearing: on this data each one returns B1's
 * nodes. Without that half, a guard that refused everything would pass.
 *
 * Skips only when NEO4J_URI is absent, and refuses to skip in CI.
 *
 * CI: rls-integration job (neo4j:5.24-community service).
 * Local: NEO4J_URI=bolt://localhost:7687 NEO4J_USERNAME=neo4j \
 *          NEO4J_PASSWORD=oxagen-dev pnpm --filter @oxagen/ontology test:integration
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInTenantScope, TenantScopeError } from "@oxagen/tenancy";
import { closeDriver, session } from "../src/client";
import { scopedSession } from "../src/tenant";
import {
  createCypherProvisioner,
  OrgGraphProvisionError,
  provisionOrgGraph,
} from "../src/provision";

const HAS_NEO4J = Boolean(process.env["NEO4J_URI"]);
if (!HAS_NEO4J && process.env["CI"]) {
  throw new Error(
    "NEO4J_URI is not set in CI: the graph cross-tenant probe must run there, not skip",
  );
}

// Fresh ids per run, so a rerun against a long-lived local Neo4j never meets
// the previous run's rows, and cleanup can target exactly what this run wrote.
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const WS_A1 = randomUUID();
const WS_A2 = randomUUID();
const WS_B1 = randomUUID();

type Tenant = { readonly orgId: string; readonly workspaceId: string };
const A1: Tenant = { orgId: ORG_A, workspaceId: WS_A1 };
const A2: Tenant = { orgId: ORG_A, workspaceId: WS_A2 };
const B1: Tenant = { orgId: ORG_B, workspaceId: WS_B1 };

/** Three nodes in a chain per tenant: <tag>-1 -> <tag>-2 -> <tag>-3. */
const NODES = [1, 2, 3] as const;
const publicId = (tag: string, n: number) => `${tag}-${n}-${ORG_A.slice(0, 8)}`;

/**
 * The natural key A1 and B1 both write for their first node. Ingestion MERGEs
 * on (naturalKey, orgId), so the same key in two organisations must stay two
 * nodes — the MERGE must never match across the boundary. (A2 uses its own:
 * a real natural key embeds the connection id, and a connection belongs to one
 * workspace.)
 */
const SHARED_NATURAL_KEY = `github:conn:shared-${ORG_A.slice(0, 8)}`;

function inScope<T>(tenant: Tenant, fn: () => Promise<T>): Promise<T> {
  return runInTenantScope(tenant, fn);
}

/** Run one query through the seam, as `tenant`, and return the records. */
async function scopedRun(
  tenant: Tenant,
  cypher: string,
  params: Record<string, unknown> = {},
) {
  return inScope(tenant, async () => {
    const s = scopedSession();
    try {
      return (await s.run(cypher, params)).records;
    } finally {
      await s.close();
    }
  });
}

/** Run one query with NO seam: a raw session on the pooled database. */
async function rawRun(cypher: string, params: Record<string, unknown> = {}) {
  const s = session();
  try {
    return (await s.run(cypher, params)).records;
  } finally {
    await s.close();
  }
}

/** The tenant a returned node belongs to, by the tag in its publicId. */
function tagsOf(ids: readonly string[]): Set<string> {
  return new Set(ids.map((id) => id.split("-")[0]!));
}

/**
 * Seed one tenant through the seam, with the shapes the ingestion write path
 * uses (`packages/ingestion/src/mutations/upsert-entity.ts`): MERGE on
 * (naturalKey, orgId), stamp the workspace, then MERGE the edge between two
 * anchored MATCHes.
 */
async function seed(tenant: Tenant, tag: string): Promise<void> {
  for (const n of NODES) {
    await scopedRun(
      tenant,
      `MERGE (n:EntityNode {naturalKey: $naturalKey, orgId: $orgId})
       ON CREATE SET n.publicId = $publicId, n.createdAt = datetime()
       SET n:GraphNode,
           n.workspaceId = $workspaceId,
           n.label       = 'Issue',
           n.displayName = $publicId,
           n.is_system   = false`,
      {
        naturalKey:
          n === 1 && tag !== "a2"
            ? SHARED_NATURAL_KEY
            : `github:conn:${tag}-${n}-${ORG_A}`,
        publicId: publicId(tag, n),
      },
    );
  }
  for (const [from, to] of [
    [1, 2],
    [2, 3],
  ] as const) {
    await scopedRun(
      tenant,
      `MATCH (a:EntityNode {publicId: $from, orgId: $orgId})
       MATCH (b:EntityNode {publicId: $to, orgId: $orgId})
       MERGE (a)-[r:RELATES_TO]->(b)
       SET r.workspaceId = $workspaceId`,
      { from: publicId(tag, from), to: publicId(tag, to) },
    );
  }
}

describe.skipIf(!HAS_NEO4J)(
  "graph tenant isolation — real Neo4j, pooled database",
  () => {
    beforeAll(async () => {
      await seed(A1, "a1");
      await seed(A2, "a2");
      await seed(B1, "b1");
    });

    afterAll(async () => {
      await rawRun("MATCH (n) WHERE n.orgId IN $orgs DETACH DELETE n", {
        orgs: [ORG_A, ORG_B],
      });
      await closeDriver();
    });

    it("seeded every tenant through the seam", async () => {
      const rows = await rawRun(
        "MATCH (n:GraphNode) WHERE n.orgId IN $orgs RETURN n.publicId AS id",
        { orgs: [ORG_A, ORG_B] },
      );
      expect(tagsOf(rows.map((r) => r.get("id") as string))).toEqual(
        new Set(["a1", "a2", "b1"]),
      );
      // The shared natural key made one node per organisation, each keeping
      // the publicId its own tenant gave it.
      const shared = await rawRun(
        "MATCH (n:EntityNode {naturalKey: $k}) RETURN n.orgId AS org, n.publicId AS id",
        { k: SHARED_NATURAL_KEY },
      );
      expect(
        shared
          .map((r) => `${r.get("org") as string}:${r.get("id") as string}`)
          .sort(),
      ).toEqual(
        [
          `${ORG_A}:${publicId("a1", 1)}`,
          `${ORG_B}:${publicId("b1", 1)}`,
        ].sort(),
      );
    });

    // graph.node.list — `packages/handlers/src/graph.node.list.ts`.
    it("a workspace listing sees only its own workspace", async () => {
      const rows = await scopedRun(
        A1,
        `MATCH (n:GraphNode)
         WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId
           AND n.is_system = false
         RETURN n.publicId AS id`,
      );
      const tags = tagsOf(rows.map((r) => r.get("id") as string));
      expect(tags.has("b1")).toBe(false);
      expect(tags.has("a2")).toBe(false);
      expect(rows.length).toBeGreaterThan(0);
    });

    // graph.node.get — `packages/handlers/src/graph.node.get.ts`.
    it("fetching another tenant's node by its id finds nothing", async () => {
      for (const foreign of [publicId("b1", 2), publicId("a2", 2)]) {
        const rows = await scopedRun(
          A1,
          `MATCH (n:GraphNode {publicId: $id, orgId: $orgId, workspaceId: $workspaceId})
           RETURN n.publicId AS id`,
          { id: foreign },
        );
        expect(rows).toHaveLength(0);
      }
    });

    // ontology.query — `packages/handlers/src/ontology.query.ts`, with the
    // start node taken from another tenant: the probe must find no start, and
    // a walk from A1's own start must never leave A1.
    it("a traversal never reaches another tenant", async () => {
      const probe = await scopedRun(
        A1,
        `MATCH (start:GraphNode {publicId: $startNodeId, orgId: $orgId, workspaceId: $workspaceId})
         RETURN start.publicId AS id`,
        { startNodeId: publicId("b1", 1) },
      );
      expect(probe).toHaveLength(0);

      const walk = await scopedRun(
        A1,
        `MATCH (start:GraphNode {publicId: $startNodeId, orgId: $orgId, workspaceId: $workspaceId})
         MATCH path = (start)-[r*1..5]-(reached:GraphNode)
         WHERE reached.orgId = $orgId AND reached.workspaceId = $workspaceId
           AND ALL(n IN nodes(path) WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId)
         RETURN DISTINCT reached.publicId AS id`,
        { startNodeId: publicId("a1", 2) },
      );
      expect(tagsOf(walk.map((r) => r.get("id") as string))).toEqual(
        new Set(["a1"]),
      );
    });

    // The one traversal the seam still accepts without a per-node filter
    // (`tenant.scope-guard.test.ts`, "KNOWN cross-tenant reads"). It crosses
    // tenants only over a cross-tenant edge, and a graph written through the
    // seam has none — this is the real-engine half of that argument.
    it("an unfiltered traversal from an anchored node stays inside the organisation", async () => {
      const rows = await scopedRun(
        B1,
        `MATCH (a:GraphNode {orgId: $orgId})-[*1..3]-(b)
         RETURN DISTINCT b.orgId AS org`,
      );
      expect(rows.map((r) => r.get("org") as string)).toEqual([ORG_B]);
    });

    // Workspace isolation inside one organisation is a PREDICATE, not a seam
    // property: the seam requires the org anchor only. A read anchored on the
    // organisation alone sees its sibling workspace and never the other
    // organisation. Every workspace-scoped production read carries the
    // workspace predicate, as the tests above show.
    it("an organisation-wide read sees its own workspaces and no other organisation", async () => {
      const rows = await scopedRun(
        A1,
        "MATCH (n:GraphNode) WHERE n.orgId = $orgId RETURN n.publicId AS id",
      );
      expect(tagsOf(rows.map((r) => r.get("id") as string))).toEqual(
        new Set(["a1", "a2"]),
      );
    });

    // The formerly accepted cross-tenant reads (ADR-087, "KNOWN cross-tenant
    // reads"). The seam refuses each before it reaches Neo4j; the raw run shows
    // what it would have returned.
    const refused: Array<[name: string, cypher: string]> = [
      [
        "a second, unanchored MATCH",
        "MATCH (a:GraphNode {orgId: $orgId}) MATCH (b:GraphNode) RETURN b.publicId AS id",
      ],
      [
        "a Cartesian product",
        "MATCH (a:GraphNode {orgId: $orgId}), (b:GraphNode) RETURN b.publicId AS id",
      ],
      [
        "an unanchored OPTIONAL MATCH",
        "MATCH (a:GraphNode {orgId: $orgId}) OPTIONAL MATCH (b:GraphNode) RETURN b.publicId AS id",
      ],
    ];

    for (const [name, cypher] of refused) {
      it(`refuses ${name}, which reads another organisation when run raw`, async () => {
        await expect(scopedRun(A1, cypher)).rejects.toBeInstanceOf(
          TenantScopeError,
        );
        const leaked = await rawRun(cypher, {
          orgId: ORG_A,
          workspaceId: WS_A1,
        });
        expect(tagsOf(leaked.map((r) => r.get("id") as string)).has("b1")).toBe(
          true,
        );
      });
    }

    it("places a free organisation in the pooled database", async () => {
      await expect(
        provisionOrgGraph({ orgId: ORG_A, namespace: "m0a", planType: "free" }),
      ).resolves.toEqual({ mode: "pooled" });
    });

    // Community Edition has one user database. The Cypher provisioner's
    // statement is refused by the engine, and the refusal arrives typed —
    // never as a paid organisation silently placed in the pool.
    it("surfaces the engine's refusal of CREATE DATABASE as a typed error on Community", async () => {
      const edition = await rawRun(
        "CALL dbms.components() YIELD edition RETURN edition",
      );
      if (edition[0]?.get("edition") !== "community") return;
      await expect(
        createCypherProvisioner().provision({
          orgId: ORG_A,
          namespace: "m0a",
        }),
      ).rejects.toBeInstanceOf(OrgGraphProvisionError);
    });
  },
);
