import { z } from "zod";
import { defineTool } from "./_define";
import { connectionList } from "../connection.list";
import { integrationList } from "../integration.list";
import { integrationGet } from "../integration.get";
import { integrationMetrics } from "../integration.metrics";
import { schemaReconcileStatus } from "../schema.reconcile.status";

/**
 * Appendix E: `list_sources` — "health, cursors, counts". Absorbs
 * `list_connections`, `list_integrations`, `list_plugins`, `get_integration`,
 * `get_integration_metrics` and `get_reconcile_status`.
 *
 * Six read contracts over what §14 draws as one tab (Ontology → Sources:
 * "connectors, sync health, entity provenance"). The six exist because v1 had
 * three parallel object models — connections, integrations, plugin listings —
 * for the same idea. v2 has one: a source.
 *
 * Two decisions to check:
 *
 * 1. **The list and the detail are one tool.** `get_integration` and
 *    `get_integration_metrics` are folded in as `sourceId` + `includeMetrics`
 *    rather than surviving as reads, because Appendix E's drop list says reads
 *    of this shape are "folded into the objects above". One row shape serves the
 *    tab and the drawer, so the drawer cannot show a field the tab computed
 *    differently.
 *
 * 2. **No credentials, ever.** `get_integration` returned `config` — the plugin
 *    instance's configuration bag, which is where a connector's credential
 *    material lived. It is dropped, not redacted. §6.8 makes the credential
 *    broker the only path to a secret and Appendix E's own note on
 *    `list_connections` is "never returns secrets"; a bag that *might* contain
 *    one is a bag that will eventually contain one.
 */
export const listSources = defineTool({
  name: "list_sources",
  domain: "connection",
  description:
    "List the workspace's connector sources with sync health, ingestion cursors, entity counts, and the latest schema reconciliation. Pass sourceId for one source in detail.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,

  absorbs: [
    "list_connections",
    "list_integrations",
    "list_plugins",
    "get_integration",
    "get_integration_metrics",
    "get_reconcile_status",
  ],
  renames: [
    {
      from: "integrationId",
      source: "get_integration",
      to: "sourceId",
      why: "the subject is renamed, not lost. Appendix E replaces v1's three parallel object models — connections, integrations, plugin listings — with one *source* (`add_source`, `update_source`, `remove_source`, `list_sources`), and drops the plugin family outright ('no marketplace in v1; sources and tool servers replace it'). An `integrationId` was a plugin *instance* id; there are no plugin instances to address. Carried by import from `get_integration`'s own field, so it still resolves the same identifier `add_source` returns as `sourceId`",
    },
    {
      from: "integrationId",
      source: "get_integration_metrics",
      to: "sourceId",
      why: "as `get_integration`'s. Metrics are folded in as `includeMetrics` on the same subject rather than surviving as a second read with its own identifier — one source id, whether the caller wants the row or the row plus its per-label entity breakdown",
    },
  ],
  drops: [
    {
      field: "pluginId",
      from: "list_integrations",
      why: "input filter; folded into `connectorId`, which is the one identifier a v2 source has. §11.2 names three connectors and Appendix E drops the plugin family, so filtering by plugin type filters an axis that no longer exists",
    },
    {
      field: "version",
      from: "list_integrations",
      why: "output; a plugin instance's version was a marketplace concept. Connector versions ship with the product, so the field would report the deployment, not the source",
    },
    {
      field: "pluginType",
      from: "list_plugins",
      why: "input filter; the five plugin types split across `list_sources` and `list_tool_servers` in v2, so a type filter here can only ever mean 'source'",
    },
    {
      field: "listings",
      from: "list_plugins",
      why: "output; the whole listing row (source, name, title, iconUrl, endpointUrl, transport, authConfig, enabled, config, and the six audit columns) is the marketplace catalog's shape. Appendix E drops the marketplace; the fields of it a source still needs — displayName, status, createdAt — come from `list_connections`' row instead",
    },
    {
      field: "config",
      from: "get_integration",
      why: "output; the instance configuration bag is where connector credential material lived, and §6.8 makes the credential broker the only path to a secret. Dropped rather than redacted — a bag that may hold a secret eventually will",
    },
    {
      field: "schema",
      from: "get_integration",
      why: "output; a connector's declared record schema is now read through `get_ontology` (§11.8 — the ontology is the one place a class is defined), not per-source. Two answers to 'what shape is this data' is how they drift",
    },
    {
      field: "executionId",
      from: "get_reconcile_status",
      why: "input; §14's Sources tab shows the latest reconciliation per source, not an arbitrary job. A specific reconcile run stays addressable through `get_run`, which is where Appendix E puts run detail",
    },
    {
      field: "status",
      from: "get_reconcile_status",
      why: "output field name collides with the source's own lifecycle status; carried inside the `reconcile` block as `reconcile.status` so a caller cannot confuse a finished reconcile with a connected source",
    },
  ],

  // `list_connections` is medium; the other five are low. The stricter carries —
  // a source row names the systems an organization has connected and how much of
  // each is in the graph, which is competitive information even without a secret
  // in it.
  agent: { requiresApproval: false, riskLevel: "low", category: "read" },
  sensitivity: "medium",
  defaultEffect: "deny",
  /**
   * The sources disagree at workspace scope: `get_reconcile_status` allows
   * Viewer, `list_plugins` allows Member, `list_connections` allows Member. The
   * strictest is Owner/Member, so **Viewer does not carry**. Worth a reviewer's
   * eye: it means a Viewer cannot see the Sources tab at all. The trade is
   * deliberate — `medium` sensitivity and read-only are not the same claim, and
   * the Viewer allowance came from the one source (a reconcile job's progress
   * counters) that exposed no connector identity.
   */
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  /**
   * Verified against all six handlers, not assumed from the names:
   * connection.list.ts, integration.list.ts, plugin.org.list.ts,
   * integration.get.ts, integration.metrics.ts and schema.reconcile.status.ts
   * each open a read transaction and write nothing. (`get_ontology`'s sources do
   * not pass this check — see that file.)
   */
  mutates: false,

  input: z.object({
    /**
     * Carried from `list_connections`, which has the six-state lifecycle.
     * `list_integrations`' four-state enum is the narrower of the two and would
     * have made `deleting` and `deleted` unfilterable — the two states a
     * customer most wants to see while a `remove_source` job is running.
     */
    status: connectionList.input.shape.status,

    // Carried from `list_connections`.
    connectorId: connectionList.input.shape.connectorId,

    /**
     * Detail mode, carried from `get_integration`'s identifier. When set, one
     * source is returned and `includeMetrics` defaults to being worth setting:
     * the per-type entity breakdown is expensive enough that the list view
     * should not pay for it.
     *
     * The validation is carried by import, but the `describe()` is overridden:
     * `get_integration` documented this field as "Plugin instance ID", and this
     * rename's own reason is that there are no plugin instances left to
     * address. `describe()` is what the MCP parameter builder shows a caller, so
     * carrying it unchanged would ship the exact sentence the rename contradicts
     * — the same trap `retract_record` avoided by retyping `memoryId`.
     */
    sourceId: integrationGet.input.shape.integrationId
      .optional()
      .describe("Public id of one source, for detail mode"),

    /**
     * Folds `get_integration_metrics` in as a flag. Off by default because
     * `entityCountByType` is a per-label aggregation over the graph, and §14's
     * Sources tab renders a row per source without it.
     */
    includeMetrics: z.boolean().default(false),

    // Carried from `list_integrations` with its 1–250 cap and its 50 default.
    limit: integrationList.input.shape.limit,
    offset: integrationList.input.shape.offset,
  }),

  output: z.object({
    sources: z.array(
      z.object({
        // Identity and lifecycle, carried off `list_connections`' row so the
        // health fields below keep the comment that says who computes them.
        id: connectionList.output.shape.connections.element.shape.id,
        publicId:
          connectionList.output.shape.connections.element.shape.publicId,
        connectorId:
          connectionList.output.shape.connections.element.shape.connectorId,
        displayName:
          connectionList.output.shape.connections.element.shape.displayName,
        status: connectionList.output.shape.connections.element.shape.status,
        createdAt:
          connectionList.output.shape.connections.element.shape.createdAt,

        /**
         * "Health" in Appendix E's `Does` column. Carried by import because the
         * v1 row already documents who writes them — "poll/sync health rolled up
         * by the connector poll loop" — which is the provenance a trust badge
         * needs (§14: every badge shows the recorded value and nothing stronger).
         */
        healthStatus:
          connectionList.output.shape.connections.element.shape.healthStatus,
        lastSyncAt:
          connectionList.output.shape.connections.element.shape.lastSyncAt,
        lastPollAt:
          connectionList.output.shape.connections.element.shape.lastPollAt,

        /**
         * "Cursors". §11.2 puts the cursor and health in Postgres while the
         * records live in the graph, so this is the field that says how far a
         * source has been read. `nextPollAt` is carried despite §11.4 removing
         * polling for *repositories*, because the Linear and Postgres connectors
         * are still poll-driven — it is null for webhook sources.
         */
        nextPollAt:
          connectionList.output.shape.connections.element.shape.nextPollAt,

        // "Counts".
        entityCount:
          connectionList.output.shape.connections.element.shape.entityCount,

        // Carried from `list_integrations`' row: the failure text a degraded
        // source shows. `list_connections` had health but no reason.
        errorMessage:
          integrationList.output.shape.integrations.element.shape.errorMessage,

        /**
         * Present only when `includeMetrics` is set. Carried whole from
         * `get_integration_metrics` — the per-label breakdown is what §14 calls
         * entity provenance on the Sources tab, and `lastSyncDurationMs` is what
         * makes a slow source distinguishable from a stalled one.
         */
        metrics: z
          .object({
            entityCountByType:
              integrationMetrics.output.shape.entityCountByType,
            lastSyncDurationMs:
              integrationMetrics.output.shape.lastSyncDurationMs,
            lastErrorAt: integrationMetrics.output.shape.lastErrorAt,
          })
          .optional(),

        /**
         * The latest schema reconciliation for this source, carried from
         * `get_reconcile_status`. Null when the source has never been
         * reconciled. The pruned counters are the ones that matter to a reader:
         * §11.7's drift report and §11.2 step 4's migration both land here, and
         * "how many nodes did activation prune" is the number an operator checks
         * after a merge.
         */
        reconcile: z
          .object({
            status: schemaReconcileStatus.output.shape.status,
            totalNodes: schemaReconcileStatus.output.shape.totalNodes,
            processedNodes: schemaReconcileStatus.output.shape.processedNodes,
            updatedNodes: schemaReconcileStatus.output.shape.updatedNodes,
            totalRelationships:
              schemaReconcileStatus.output.shape.totalRelationships,
            processedRelationships:
              schemaReconcileStatus.output.shape.processedRelationships,
            updatedRelationships:
              schemaReconcileStatus.output.shape.updatedRelationships,
            prunedNodes: schemaReconcileStatus.output.shape.prunedNodes,
            prunedRelationships:
              schemaReconcileStatus.output.shape.prunedRelationships,
          })
          .nullable(),
      }),
    ),

    // Carried from `list_integrations`, the one source that paginated.
    total: integrationList.output.shape.total,
    hasMore: integrationList.output.shape.hasMore,
  }),
});

export type ListSourcesInput = z.output<typeof listSources.input>;
export type ListSourcesOutput = z.output<typeof listSources.output>;
