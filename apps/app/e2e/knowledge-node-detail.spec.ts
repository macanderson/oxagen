import { test, expect } from "@playwright/test";
import neo4j, { type Driver } from "neo4j-driver";
import { loginWithSession } from "./helpers/auth";
import { gotoStable } from "./helpers/nav";
import {
  setupAgentRuntimeFixture,
  teardownFixture,
  type AgentRuntimeFixture,
} from "./helpers/agent-runtime-fixture";

/**
 * knowledge-node-detail.spec.ts — Knowledge → Graph → node-detail coverage
 * (spec: docs/web-app-2.0/workspace/knowledge/graph/node/spec.md).
 *
 * Asserts the citation rule end-to-end:
 *   1. The header shows the human displayName + domain label badge — never
 *      the node's raw publicId — as the primary on-screen identifier. The raw
 *      id is present, but only inside the metadata section's CopyableId.
 *   2. The Neighbors section renders an adjacent node, grouped under its
 *      relationship type, once one is seeded.
 *   3. A never-seeded node id renders the friendly not-found state, not a
 *      raw 500 or crash.
 *
 * There is no node-detail admin-actions panel — node-admin-actions.tsx and
 * its server actions do not exist, and nothing under apps/app/src renders
 * "Admin actions" or a Delete node control. page.tsx is a read-only detail
 * view.
 *
 * Seeding: setupAgentRuntimeFixture gives a real org + workspace + owner
 * session (org.org_users.role = 'owner' — the exact row getOrgRole /
 * assertOrgAdmin check) without driving the slower /signup UI flow. Two
 * :GraphNode rows + one relationship are seeded directly via neo4j-driver,
 * mirroring the shape graph.node.get / ontology.neighbors read (see
 * packages/handlers/src/graph.node.get.ts and ontology.neighbors.ts): label
 * :GraphNode, {orgId, workspaceId, publicId, label, displayName, description,
 * properties, is_system, createdAt, updatedAt} per node, plus a typed
 * relationship.
 *
 * `is_system = false` is required, not decorative: every workspace-graph read
 * filters on it (graph.node.get, graph.node_label.get, ontology.neighbors,
 * graph.stats), and in Cypher a missing property compares as null, so a node
 * seeded without it is invisible to all of them. The real writer sets it on
 * every entity it upserts (packages/ingestion/src/mutations/upsert-entity.ts).
 */

function deQuote(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))
    return raw.slice(1, -1);
  return raw;
}

const NEO4J_URL = deQuote(
  process.env.NEO4J_URI ?? process.env.NEO4J_URL,
  "bolt://localhost:7687",
);
const NEO4J_USER = deQuote(
  process.env.NEO4J_USERNAME ?? process.env.NEO4J_USER,
  "neo4j",
);
const NEO4J_PASSWORD = deQuote(process.env.NEO4J_PASSWORD, "oxagen-dev");

const ORG_SLUG = "e2e-node-detail";
const WS_SLUG = "main";
const USER_EMAIL = "e2e+node-detail@oxagen.ai";

const PRIMARY_NODE_ID = "kn_e2e_node_detail_primary";
const NEIGHBOR_NODE_ID = "kn_e2e_node_detail_neighbor";
const NEVER_SEEDED_NODE_ID = "kn_e2e_node_detail_never_seeded";
const REL_TYPE = "RELATES_TO";

let fixture: AgentRuntimeFixture;
let driver: Driver | null = null;
let neo4jReachable = true;

async function seedGraph(orgId: string, workspaceId: string): Promise<void> {
  driver = neo4j.driver(
    NEO4J_URL,
    neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
  );
  const session = driver.session();
  try {
    await session.run(
      `MERGE (n:GraphNode {publicId: $publicId, orgId: $orgId, workspaceId: $workspaceId})
       SET n.label = $label,
           n.displayName = $displayName,
           n.description = $description,
           n.properties = $properties,
           n.is_system = false,
           n.createdAt = datetime(),
           n.updatedAt = datetime()`,
      {
        publicId: PRIMARY_NODE_ID,
        orgId,
        workspaceId,
        label: "Feature",
        displayName: "E2E Node Detail Primary",
        description: "Seeded node for knowledge-node-detail.spec.ts",
        properties: JSON.stringify({ owner: "platform" }),
      },
    );
    await session.run(
      `MERGE (n:GraphNode {publicId: $publicId, orgId: $orgId, workspaceId: $workspaceId})
       SET n.label = $label,
           n.displayName = $displayName,
           n.description = $description,
           n.properties = $properties,
           n.is_system = false,
           n.createdAt = datetime(),
           n.updatedAt = datetime()`,
      {
        publicId: NEIGHBOR_NODE_ID,
        orgId,
        workspaceId,
        label: "Repository",
        displayName: "E2E Node Detail Neighbor",
        description: null,
        properties: JSON.stringify({}),
      },
    );
    await session.run(
      `MATCH (a:GraphNode {publicId: $fromId, orgId: $orgId, workspaceId: $workspaceId})
       MATCH (b:GraphNode {publicId: $toId, orgId: $orgId, workspaceId: $workspaceId})
       MERGE (a)-[r:${REL_TYPE}]->(b)
       SET r.orgId = $orgId, r.recordedAt = datetime()`,
      { fromId: PRIMARY_NODE_ID, toId: NEIGHBOR_NODE_ID, orgId, workspaceId },
    );
  } finally {
    await session.close();
  }
}

async function teardownGraph(orgId: string): Promise<void> {
  if (!driver) return;
  try {
    const session = driver.session();
    try {
      await session.run(`MATCH (n:GraphNode {orgId: $orgId}) DETACH DELETE n`, {
        orgId,
      });
    } finally {
      await session.close();
    }
  } catch {
    // Neo4j may not be reachable — tolerate, mirrors the fixture's own guard.
  } finally {
    await driver.close();
  }
}

test.describe("knowledge node detail — citation rule + neighbors", () => {
  test.beforeAll(async () => {
    fixture = await setupAgentRuntimeFixture({
      orgSlug: ORG_SLUG,
      workspaceSlug: WS_SLUG,
      userEmail: USER_EMAIL,
    });
    try {
      await seedGraph(fixture.orgId, fixture.workspaceId);
    } catch {
      // Neo4j may not be reachable in some local dev configs — the tests
      // below tolerate a not-found/empty page rather than hard-failing.
      neo4jReachable = false;
    }
  });

  test.afterAll(async () => {
    await teardownGraph(fixture.orgId);
    await teardownFixture({ orgSlug: ORG_SLUG });
  });

  test("header shows the human label (not the raw node id); neighbors render", async ({
    page,
    context,
    baseURL,
  }) => {
    test.skip(!neo4jReachable, "Neo4j not reachable — seeding failed");

    await loginWithSession(context, fixture.sessionToken, baseURL);
    await gotoStable(
      page,
      `/${ORG_SLUG}/${WS_SLUG}/knowledge/graph/${PRIMARY_NODE_ID}`,
    );
    await expect(page).not.toHaveURL(/\/login/);
    await page.waitForLoadState("domcontentloaded");

    // ── Citation rule: displayName + domain label, never the raw id ─────────
    // Two h1s render on this route: the Knowledge layout's page header
    // ("Knowledge", from layout.tsx's PageHeader) and the node card's own
    // heading, which page.tsx renders after {children}. Take the last one —
    // an unscoped level-1 locator resolves to both and trips strict mode.
    const heading = page.getByRole("heading", { level: 1 }).last();
    await expect(heading).toHaveText("E2E Node Detail Primary", {
      timeout: 15_000,
    });
    await expect(heading).not.toContainText(PRIMARY_NODE_ID);
    await expect(
      page.getByText("Feature", { exact: true }).first(),
    ).toBeVisible();

    // The raw id IS present, but only inside the metadata section's
    // CopyableId control (never as the primary heading identifier).
    await expect(
      page.getByRole("button", {
        name: new RegExp(`Copy ID ${PRIMARY_NODE_ID}`),
      }),
    ).toBeVisible();

    // ── Neighbors section ────────────────────────────────────────────────────
    await expect(
      page.getByRole("heading", { name: "Neighbors" }),
    ).toBeVisible();
    await expect(page.getByText("E2E Node Detail Neighbor")).toBeVisible({
      timeout: 15_000,
    });

    // No admin-actions assertion: there is no such panel (see the
    // file header). The node-detail route is a read-only view.
  });

  test("a never-seeded node id renders the friendly not-found state, not a crash", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginWithSession(context, fixture.sessionToken, baseURL);
    await gotoStable(
      page,
      `/${ORG_SLUG}/${WS_SLUG}/knowledge/graph/${NEVER_SEEDED_NODE_ID}`,
    );
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByText("Node not found")).toBeVisible({
      timeout: 15_000,
    });
  });
});
