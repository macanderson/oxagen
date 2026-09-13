import { z } from "zod";
import { defineTool } from "./_define";
import { connectionDelete } from "../connection.delete";

/**
 * Appendix E: `remove_source`. Absorbs `delete_connection` and
 * `uninstall_plugin`.
 *
 * Appendix E leaves the `Does` column empty, so the job comes from the sources
 * and from §11.1: a source owns `:Source`, `:SyncRun` and `:SourceRecord` nodes,
 * and entities hold `DERIVED_FROM → :SourceRecord` provenance back to them.
 * Removing a source therefore has to answer a question that removing a row does
 * not: what happens to the entities that were resolved from its records?
 *
 * `delete_connection` already answered it with a three-way mode, and that mode
 * is the whole reason this carry is a 1:1 on the interesting field. The three
 * values are not a convenience — they are the three defensible positions:
 * revoke the credential and keep what was learned, forget what was learned and
 * keep the credential, or both.
 *
 * `uninstall_plugin` contributes nothing but its name to the absorbs list. It
 * was the marketplace's uninstall verb, it soft-deleted a listing row and its
 * dependent MCP server rows, and Appendix E drops both the marketplace and the
 * listing ("no marketplace in v1; sources and tool servers replace it"). Its
 * synchronous `{ ok: boolean }` is replaced by the async deletion job, because a
 * purge of graph data is not something a request can finish.
 */
export const removeSource = defineTool({
  name: "remove_source",
  domain: "connection",
  description:
    "Remove a connector source. Chooses what survives: revoke the credential and keep the graph data, delete the graph data and keep the source, or delete both.",
  mode: "async",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,

  absorbs: ["delete_connection", "uninstall_plugin"],
  renames: [
    {
      from: "connectionId",
      source: "delete_connection",
      to: "sourceId",
      why: "Appendix E renames the concept: `create_connection` becomes `add_source` and the object it returns is a source, so every later call addresses `sourceId`. The rename is not cosmetic — §11.1 gives a source its own graph identity (`:Source`, `:SyncRun`, `:SourceRecord`), while a *connection* in v2 means something narrower and still live: the vault credential (§6.8, `set_connection`). Keeping `connectionId` here would name the credential, and `mode: 'connection_only'` on this very tool is the option that deletes the credential and keeps the source's records — the two must not share a name. Carried by import, so the min(1) and the describe() stay attached",
    },
  ],
  drops: [
    {
      field: "orgListingId",
      from: "uninstall_plugin",
      why: "Appendix E drops the plugin family outright ('no marketplace in v1; sources and tool servers replace it'), so there is no listing row to address. A source is addressed by `sourceId`, the identifier `add_source` returned",
    },
    {
      field: "ok",
      from: "uninstall_plugin",
      why: "output; a synchronous boolean cannot describe a purge of :SourceRecord nodes and the entity provenance hanging off them (§11.1). Replaced by `delete_connection`'s deletion-job handle, which the caller can actually follow",
    },
  ],

  // `delete_connection` is high/high/approval; `uninstall_plugin` is
  // destructive/high/approval. The stricter sensitivity carries: with
  // mode `data_only` or `full` this erases entity provenance, which is the
  // definition of destructive rather than merely sensitive.
  agent: {
    requiresApproval: true,
    riskLevel: "high",
    category: "destructive",
  },
  sensitivity: "destructive",
  defaultEffect: "deny",
  // `uninstall_plugin` allowed workspace Admin; `delete_connection` allowed
  // Owner only. The stricter carries.
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  // Revokes credentials and/or deletes graph nodes. Both sources mutate.
  mutates: true,

  input: z.object({
    // Carried from `delete_connection` with its min(1) and its describe().
    sourceId: connectionDelete.input.shape.connectionId,

    /**
     * Carried verbatim, default included. The describe() spells out all three
     * consequences, and it is the single most important string in this file:
     * it is what a customer reads before an irreversible act. §11.1's
     * `DERIVED_FROM` provenance is why `connection_only` is a real option and
     * not a half-measure — keeping the records keeps every entity resolved from
     * them citable, even after the credential is gone.
     */
    mode: connectionDelete.input.shape.mode,
  }),

  output: z.object({
    // Carried whole from `delete_connection`. The `running` literal (not
    // `queued`) carries too: the deletion_jobs row exists and is progressing by
    // the time the caller has this handle.
    deletionJobId: connectionDelete.output.shape.deletionJobId,
    mode: connectionDelete.output.shape.mode,
    status: connectionDelete.output.shape.status,

    sourceId: z.string(),
  }),
});

export type RemoveSourceInput = z.output<typeof removeSource.input>;
export type RemoveSourceOutput = z.output<typeof removeSource.output>;
