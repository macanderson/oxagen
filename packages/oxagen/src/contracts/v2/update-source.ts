import { z } from "zod";
import { defineTool } from "./_define";
import { connectionUpdate } from "../connection.update";
import { connectionMappingsSet } from "../connection.mappings.set";
import { connectionMappingsSuggest } from "../connection.mappings.suggest";
import { connectionPause } from "../connection.pause";
import { connectionPreview } from "../connection.preview";

/**
 * Appendix E: `update_source` — "mappings, state". Absorbs `update_connection`,
 * `set_connection_mappings`, `suggest_connection_mappings`, `pause_connection`
 * and `preview_connection`.
 *
 * Five v1 contracts, but only two jobs, and the `Does` column names both.
 * **Mappings**: which source record types become which ontology classes.
 * **State**: the source's name, its delivery config, and whether it is paused.
 *
 * The judgment call worth checking is `suggestMappings`. `preview_connection`
 * and `suggest_connection_mappings` are the read half of v1's setup wizard: one
 * fetched sample records, the other fed them to a model. They are folded in as a
 * dry-run flag rather than left as separate reads because the wizard's two-call
 * shape is what made them separate — v1 made the *client* carry preview output
 * back into the suggest call. §11.2 step 2 puts that sequence inside the
 * product ("a deterministic profiler reads a sample… a model names and describes
 * candidates only after the deterministic pass"), so the caller asks one
 * question and the boundary between the profiler and the model stops being the
 * caller's problem.
 *
 * That fold is also why this tool's sensitivity is `high` — see below. A dry run
 * returns sample records, which are customer data.
 */
export const updateSource = defineTool({
  name: "update_source",
  domain: "connection",
  description:
    "Update a connector source: confirm the entity-type mappings that ground its ingestion, rename it, adjust delivery config, or pause and resume it. With suggestMappings, previews the source's record types and returns model-suggested mappings without writing.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,

  absorbs: [
    "update_connection",
    "set_connection_mappings",
    "suggest_connection_mappings",
    "pause_connection",
    "preview_connection",
  ],
  /**
   * All five sources identified their subject as `connectionId`; all five land
   * on the one `sourceId`. Declared per source rather than once, because the
   * check is per absorbed contract and a reader tracing any one of the five
   * should find its own row.
   */
  renames: [
    {
      from: "connectionId",
      source: "update_connection",
      to: "sourceId",
      why: "Appendix E renames the concept — `create_connection` becomes `add_source`, and the object every later call addresses is a source (§11.1: `:Source`, `:SyncRun`, `:SourceRecord`). `connection` is not free to mean this any more: in v2 it means the vault credential behind a tool server or provider (§6.8, `set_connection`). Carried by import from this contract's own field, so its min(1) and the describe() that says either a public id or an internal UUID resolves stay attached",
    },
    {
      from: "connectionId",
      source: "set_connection_mappings",
      to: "sourceId",
      why: "as `update_connection`'s — the mappings are the source's, not the credential's. §11.2 step 5 resolves entities across sources from these mappings, so the id has to name the thing that owns the records",
    },
    {
      from: "connectionId",
      source: "suggest_connection_mappings",
      to: "sourceId",
      why: "as `set_connection_mappings`'. The suggest call is folded in as `suggestMappings: true` on the same subject, so it addresses the same source it would then confirm mappings for — v1's wizard could suggest against one id and confirm against another",
    },
    {
      from: "connectionId",
      source: "pause_connection",
      to: "sourceId",
      why: "as `update_connection`'s. Pausing stops a source's ingestion; it does not touch the credential, which is exactly the distinction the rename preserves",
    },
    {
      from: "connectionId",
      source: "preview_connection",
      to: "sourceId",
      why: "as `suggest_connection_mappings`' — preview is the other half of the same `suggestMappings` dry run and samples records from the source",
    },
  ],
  drops: [
    {
      field: "activateConnection",
      from: "set_connection_mappings",
      why: "confirmed mappings are what activation means (§11.2 step 1: records land in the graph once the source is mapped). There is no state in which a workspace wants confirmed mappings and a dormant source — a source it wants stopped is `paused`, which is a field on this tool",
    },
    {
      field: "installationId",
      from: "set_connection_mappings",
      why: "GitHub App installation — moved to `link_repository`, which is where §11.4 resolves a repository through the App. It is carried there by import from this same contract",
    },
    {
      field: "selectedRepos",
      from: "set_connection_mappings",
      why: "one repository per link in v2 (§10.1 main + linked, each its own link record), so a multi-select of repo names has no target — `link_repository` takes owner/name",
    },
    {
      field: "owner",
      from: "set_connection_mappings",
      why: "derived-from-selectedRepos[0] wizard field; `link_repository` takes owner as a first-class coordinate",
    },
    {
      field: "repo",
      from: "set_connection_mappings",
      why: "as `owner` — `link_repository.name`",
    },
    {
      field: "defaultBranch",
      from: "set_connection_mappings",
      why: "§11.4 step 1 replaces GitHub's default branch with a confirmed *production* branch, required on `link_repository`. Carrying the default branch here would let a source quietly re-point what the customer confirmed",
    },
    {
      field: "syncDepthDays",
      from: "set_connection_mappings",
      why: "§11.4 step 4 clones and indexes the production branch head with full history semantics, and step 3's issue backfill is 'a one-time backfill, paginated, rate-limit aware, and resumable' over everything. A depth window would make the archive stamp (valid_to) lie about what was checked",
    },
    {
      field: "recordTypes",
      from: "suggest_connection_mappings",
      why: "v1 made the caller carry `preview_connection`'s output back into the suggest call. §11.2 step 2 puts the profiler pass inside the product, so the samples are read here rather than supplied — a caller cannot hand the model record types the source does not actually have",
    },
    {
      field: "existingEntityTypes",
      from: "suggest_connection_mappings",
      why: "the model is grounded on the workspace's pinned ontology version read from .oxagen/ontology/ (§11.8), not on a caller-supplied list of names that may be stale or invented",
    },
    {
      field: "suggestionIds",
      from: "suggest_connection_mappings",
      why: "output; the `setup_suggestions` Postgres rows are not among Appendix A's 35 target tables. A suggestion that is acted on becomes a mapping; one that is not is recorded as a frame of the run that produced it (§8.2), which is where its provenance belongs",
    },
    {
      field: "status",
      from: "update_connection",
      why: "output; replaced by `pause_connection`'s tighter `connected | paused` enum rather than v1's open `z.string()` — two sources disagreed on the type and the constrained one carries",
    },
  ],

  /**
   * Sensitivity is the strictest of the five and it comes from
   * `preview_connection`: `high`. That is not bureaucracy — a preview returns up
   * to three raw sample records per record type, which is unredacted customer
   * data from the source system, and §11.5 rule 4 ("redact before embedding")
   * exists because that data is sensitive enough to strip before it even reaches
   * an embedding model.
   *
   * riskLevel `medium` and requiresApproval `true` come from
   * `set_connection_mappings`. Confirming mappings is what starts ingestion into
   * the organization's graph, and §11.2 step 5 then resolves entities across
   * sources from it — a wrong mapping is not a wrong row, it is a wrong class.
   */
  agent: { requiresApproval: true, riskLevel: "medium", category: "ingestion" },
  sensitivity: "high",
  defaultEffect: "deny",
  // `update_connection` and `pause_connection` allowed workspace Member; the
  // three mapping/preview contracts allow Owner only. The stricter carries.
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  // Writes mappings and connection state. `suggestMappings: true` is a dry run
  // that writes nothing, but a tool that mutates on some inputs mutates.
  mutates: true,

  input: z.object({
    // Carried from `update_connection`, keeping the min(1) and the describe()
    // that says either a public id or an internal UUID resolves.
    sourceId: connectionUpdate.input.shape.connectionId,

    // Carried with its 1–200 bound. Partial update: omitted means unchanged.
    displayName: connectionUpdate.input.shape.displayName,

    /**
     * Carried by import with its nullable-clears semantics intact. Note this is
     * a *replacement*, not a merge — the describe() says so, and that is a
     * production edge case worth keeping attached to the field.
     */
    deliveryConfig: connectionUpdate.input.shape.deliveryConfig,

    /**
     * Carried from `set_connection_mappings`, made optional here because this
     * tool also does state-only updates. The inner array keeps its `.min(1)`:
     * confirming an empty mapping set is not a way to un-map a source, it is a
     * malformed call, and the original schema already knew that.
     */
    mappings: connectionMappingsSet.input.shape.mappings.optional(),

    /**
     * Carried from `pause_connection`, made optional so omitting it leaves the
     * state alone. The boolean, not a verb pair: v1 already collapsed
     * pause/resume into one field and the describe() carries the mapping.
     */
    paused: connectionPause.input.shape.paused.optional(),

    /**
     * New, and the fold described at the top of this file. When true, nothing is
     * written: the source's record types are sampled and a model proposes
     * mappings for them, returned in `preview` and `suggestions`. This is the
     * call a customer makes before the call that confirms.
     */
    suggestMappings: z.boolean().default(false),
  }),

  output: z.object({
    sourceId: z.string(),
    displayName: connectionUpdate.output.shape.displayName,
    deliveryConfig: connectionUpdate.output.shape.deliveryConfig,

    // Carried from `pause_connection` — the constrained enum, with its
    // describe(), rather than `update_connection`'s open string.
    status: connectionPause.output.shape.status,

    // Carried from `set_connection_mappings`. Zero/zero on a dry run or a
    // state-only update, which is how a caller tells a no-op from a write.
    mappingsCreated: connectionMappingsSet.output.shape.mappingsCreated,
    mappingsUpdated: connectionMappingsSet.output.shape.mappingsUpdated,

    /**
     * Present only on a `suggestMappings` call. Carried whole from
     * `preview_connection` so the `.max(3)` cap on sample records — the bound
     * that keeps raw customer data in the response small — stays attached.
     */
    preview: connectionPreview.output.shape.recordTypes.optional(),

    /**
     * Present only on a `suggestMappings` call. Carried from
     * `suggest_connection_mappings`, including `confidence` and the `reasoning`
     * string the setup wizard shows: §14's interaction rule is that every
     * explanation is a chain of links, not a summary, and the model's own
     * reasoning is the weakest link in this chain — it is shown, labelled, and
     * never applied without the confirming call.
     */
    suggestions: connectionMappingsSuggest.output.shape.suggestions.optional(),
  }),
});

export type UpdateSourceInput = z.output<typeof updateSource.input>;
export type UpdateSourceOutput = z.output<typeof updateSource.output>;
