import { z } from "zod";
import { defineTool } from "./_define";
import { pluginOrgInstall } from "../plugin.org.install";
import { integrationConfigure } from "../integration.configure";

/**
 * Appendix E: `add_source` — "connector source". Absorbs `install_plugin` and
 * `configure_integration`.
 *
 * This is the carry where the spec deletes most of what it absorbs. Appendix E's
 * drop list is explicit: "`plugin.*`, `browse_plugin_catalog`, … (no marketplace
 * in v1; **sources and tool servers replace it**)". `install_plugin` was the
 * marketplace's install verb, covering five plugin types — MCP servers, agent
 * skills, agent capabilities, knowledge sources, and integrations. Four of those
 * five go to `register_tool_server` or nowhere. Only the fifth, an ingestion
 * connector, is a source.
 *
 * So the carry is narrow by design:
 *
 * - **`connectorId` replaces `pluginId` + `pluginType`, and is closed.** §11.2:
 *   "Three connectors ship in v1: GitHub, Linear, and Postgres." v1 took a
 *   free-form plugin id against a catalog; the spec names the set, so v2 names
 *   it too and an unknown connector fails at the schema rather than at the
 *   handler. This is the spec being stricter than the code (rule F).
 * - **`authKind` carries by import from the output side.** Its comment on
 *   `install_plugin` — "oauth means the server will not work until the user
 *   completes the OAuth authorize flow" — is the whole reason the Sources tab
 *   can prompt for authentication straight after adding a source, and that
 *   knowledge would be lost by retyping the enum.
 * - **GitHub does not come through here.** A repository is `link_repository`
 *   (§11.4), which has a production branch, an issue backfill, and a code graph
 *   that no other connector has. `github` still appears in the connector enum
 *   because §11.2 lists it as a connector and a workspace can add GitHub as an
 *   ingestion source for repositories it does not index — but the repository
 *   binding itself is not this tool's job.
 */
export const addSource = defineTool({
  name: "add_source",
  domain: "connection",
  description:
    "Add an ingestion connector source to the workspace. The source syncs records into the graph as :SourceRecord nodes; the ontology engine profiles them into classes (§11.2).",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,

  absorbs: ["install_plugin", "configure_integration"],
  drops: [
    {
      field: "pluginType",
      from: "install_plugin",
      why: "Appendix E drops the plugin family: 'no marketplace in v1; sources and tool servers replace it'. Of its five types only `integration`/`knowledge_source` is a source; `mcp_server` and `agent_capability` are `register_tool_server`'s, and `agent_skill` has no v2 home",
    },
    {
      field: "pluginId",
      from: "install_plugin",
      why: "replaced by the closed `connectorId` enum — §11.2 names the three v1 connectors, so a catalog lookup is no longer what resolves a source",
    },
    {
      field: "custom",
      from: "install_plugin",
      why: "the custom-endpoint block (endpointUrl, transport, authKind) describes an MCP or HTTP tool server, which Appendix E assigns to `register_tool_server`. A connector's endpoint is the connector's, not the customer's",
    },
    {
      field: "orgListingId",
      from: "install_plugin",
      why: "output; the plugin listing row goes with the marketplace. A source is identified by `sourceId`, the identifier the Sources tab and every later update/remove call uses",
    },
    {
      field: "integrationId",
      from: "configure_integration",
      why: "input; `configure_integration` updated an existing instance, while this tool creates one — the id is assigned here, not supplied",
    },
    {
      field: "syncCadence",
      from: "configure_integration",
      why: "§11.2 and §11.4: ingestion is connector- and webhook-driven with manual re-sync (`sync_repository`), so cadence is not a per-source choice. Removing it also removes the polling interval it implied",
    },
    {
      field: "updatedAt",
      from: "configure_integration",
      why: "output; a create reports `createdAt`, and the Sources tab reads freshness from `lastSyncAt` (§14 'sync health'), not from when the row was last edited",
    },
  ],

  // `install_plugin` requires approval (medium risk); `configure_integration`
  // does not. The stricter source wins, and it is the right one: adding a source
  // opens an ingestion path into the organization's Neo4j database (§5.3) and
  // stores a credential for a third-party system (§6.8).
  agent: { requiresApproval: true, riskLevel: "medium", category: "ingestion" },
  sensitivity: "medium",
  defaultEffect: "deny",
  /**
   * The two sources disagree at workspace scope: `install_plugin` names
   * Owner/Admin, `configure_integration` names Owner/Member. Neither Admin nor
   * Member survives. Member does not because the stricter source wins — a
   * Member can update a source's mappings (`update_source`) but cannot open a
   * new ingestion path. **Admin does not because it is not a workspace role at
   * all**: `SystemWorkspaceRole` is Owner | Member | Viewer (§6.3), so
   * `install_plugin`'s workspace Admin grant was dead weight that never matched
   * a principal. Carrying it forward would have reproduced the bug.
   */
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  // Writes the source row and the credential grant, then queues the first sync.
  // Both sources mutate.
  mutates: true,

  input: z.object({
    /**
     * §11.2: "Three connectors ship in v1: GitHub (§11.4: every linked repo and
     * the main repo), Linear (teams, projects, issues), and Postgres (tables
     * selected by the customer)." Closed rather than free-form because each of
     * the three has a hand-written profiler and a built-in ontology fragment; a
     * fourth value would name a connector that cannot profile anything.
     */
    connectorId: z.enum(["github", "linear", "postgres"]),

    // Carried by import, keeping the 1–200 bound and the describe(). Optional
    // exactly as `configure_integration` had it: a source with no name is
    // labelled with its connector's, which is right for the common case of one
    // Linear or one Postgres per workspace.
    displayName: integrationConfigure.input.shape.displayName,

    /**
     * Carried by import. The connector-specific settings bag — the Postgres
     * connector's selected tables, Linear's teams. Deliberately untyped here:
     * each connector validates its own config, and the ontology engine profiles
     * what the sync produces rather than what the config claimed (§11.2 step 2).
     */
    config: integrationConfigure.input.shape.config,
  }),

  output: z.object({
    /**
     * The source's public id. Named for what §14's Sources tab calls it, and
     * carried off `configure_integration`'s output rather than retyped so the
     * identifier a caller passes to `update_source` and `remove_source` is
     * provably the same string v1 handed back.
     */
    sourceId: integrationConfigure.output.shape.integrationId,
    displayName: integrationConfigure.output.shape.displayName,

    connectorId: z.enum(["github", "linear", "postgres"]),

    /**
     * Carried by import from `install_plugin`, comment and all: "oauth" means
     * the source will not sync until the user completes the authorize flow, and
     * the UI reads this to prompt immediately rather than letting a customer
     * discover it from an empty graph an hour later.
     */
    authKind: pluginOrgInstall.output.shape.authKind,

    /**
     * New. `install_plugin` returned nothing about readiness, and a source that
     * needs OAuth is not the same as one already ingesting. The three states are
     * the ones the Sources tab has to distinguish before any sync has run;
     * `list_sources` carries the full lifecycle from `list_connections`.
     */
    status: z.enum(["pending_setup", "connected", "error"]),

    createdAt: z.string(),
  }),
});

export type AddSourceInput = z.output<typeof addSource.input>;
export type AddSourceOutput = z.output<typeof addSource.output>;
