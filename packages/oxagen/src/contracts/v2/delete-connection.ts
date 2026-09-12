import { z } from "zod";
import { defineTool } from "./_define";
import { connectionDelete } from "../connection.delete";
import { pluginCredentialRevoke } from "../plugin.credential.revoke";

/**
 * Appendix E: `delete_connection`. Absorbs `delete_connection`,
 * `delete_model_credential`, `delete_secret_key`, `unset_secret_value` and
 * `revoke_plugin_credential`.
 *
 * **The v1 name survives but the job is cut in half.** v1's `delete_connection`
 * did two things at once: revoke the credential, and delete the ingested Neo4j
 * data behind it — hence its three-mode enum and its async deletion job.
 * Appendix E splits them. `remove_source` (Ontology and knowledge) owns the
 * data half; this tool owns the credential half. That is why the mode is
 * `sync` here: with no graph sweep to run, there is nothing to track a job for.
 *
 * **Revoking is not forgetting.** Appendix A gives `tools.connections` a
 * `revoked` status rather than a delete, and `tools.credential_grants` keeps
 * every credential this connection ever minted, with `issued_at`/`revoked_at`.
 * A run that spent money under a credential must still be explainable after the
 * credential is gone, so the row is retired, not removed — the same reasoning
 * that made `delete_model_credential` a soft delete in v1.
 *
 * **Idempotent by inheritance.** `delete_model_credential` documented that
 * deleting when nothing is stored is not an error, "because the state the
 * caller asked for is the state they have". That carries: `revoked: false`
 * means there was nothing to revoke, never that the call failed.
 */
export const deleteConnection = defineTool({
  name: "delete_connection",
  domain: "tools",
  description:
    "Revoke a connection and destroy its stored credential. The connection row is retained in `revoked` status so past credential grants stay explainable. Idempotent: revoking nothing is not an error. Ingested data is not touched — that is remove_source.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  // Carried from `delete_model_credential`, and for the same reason as
  // set_connection: moving off a customer key is governance, not AI usage, and
  // must not be gated behind the balance it affects.
  noBillingGate: true,

  absorbs: [
    "delete_connection",
    "delete_model_credential",
    "delete_secret_key",
    "unset_secret_value",
    "revoke_plugin_credential",
  ],
  drops: [
    {
      field: "mode",
      from: "delete_connection",
      why: "the connection_only/data_only/full modes are the ingestion half; Appendix E assigns deleting ingested data to `remove_source`, leaving this tool the credential half — which is exactly v1's `connection_only`",
    },
    {
      field: "deletionJobId",
      from: "delete_connection",
      why: "output side of the same split: with no Neo4j sweep there is no async job, so `mode` drops from async to sync and the deletion_jobs row is remove_source's",
    },
    {
      field: "status",
      from: "delete_connection",
      why: "the literal 'running' only meant something while a deletion job existed",
    },
    {
      field: "keyId",
      from: "delete_secret_key",
      why: "one id space: tools.connections replaces the vault key, the plugin listing and the org credential singleton (see set_connection)",
    },
    {
      field: "keyId",
      from: "unset_secret_value",
      why: "same collapse",
    },
    {
      field: "environmentId",
      from: "unset_secret_value",
      why: "Appendix E drops the environment family ('environment.* … (no runtime)'); with no per-environment overrides there is no override to unset, so unset and delete are one operation",
    },
    {
      field: "orgListingId",
      from: "revoke_plugin_credential",
      why: "same collapse into connectionId; Appendix E also drops the plugin marketplace family",
    },
    {
      field: "configured / provider / status / keyHint / lastVerifiedAt / rotatedAt",
      from: "delete_model_credential",
      why: "the whole redacted credential view: Appendix E folds reads into the objects they belong to, and the post-revoke state of a connection is what `list_connections` answers. A revoke returns the fact of the revoke",
    },
  ],

  /**
   * No `agent` metadata, for the same reason as `set_connection`:
   * `delete_model_credential` deliberately declared none so the in-app agent
   * could not move its own turns onto the platform key. Absence from the belt
   * is stricter than `delete_connection`'s
   * `{ requiresApproval: true, riskLevel: "high", category: "destructive" }`,
   * so absence carries and `surfaces` drops `"agent"`.
   */
  sensitivity: "high",
  defaultEffect: "deny",
  /**
   * The strictest of the five: four of them (`delete_model_credential`,
   * `delete_secret_key`, `unset_secret_value`, `revoke_plugin_credential`)
   * grant no workspace role at all. Only v1 `delete_connection` allowed
   * workspace Owner, and it was allowed because it was a data operation.
   */
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  // Writes tools.connections (status, secret_ciphertext cleared) and revokes
  // any live grant in tools.credential_grants.
  mutates: true,

  input: z.object({
    // Carried by reference: the "public ID or internal UUID" tolerance is
    // learned behaviour, and every caller of the five sources had a different
    // id in hand.
    connectionId: connectionDelete.input.shape.connectionId,
  }),

  output: z.object({
    connectionId: z.string(),

    // Carried from `revoke_plugin_credential`, the one source whose output
    // already named the right verb.
    revoked: pluginCredentialRevoke.output.shape.revoked,

    /**
     * Appendix A `tools.connections.status`. Surfaced because `revoked: false`
     * is ambiguous on its own — nothing was stored, or the row was already
     * revoked — and an operator chasing a broken server needs to tell those
     * apart.
     */
    status: z.enum(["active", "expired", "revoked"]),

    /**
     * Servers that were left without a credential by this revoke. Appendix A
     * points `tool_servers.connection_id` at this row, and §6.7 step 5 cannot
     * broker a credential that no longer exists — so those servers stop
     * dispatching now, and the caller is told which, rather than discovering it
     * from a run's failures.
     */
    orphanedToolServerIds: z.array(z.string()).default([]),
  }),
});

export type DeleteConnectionInput = z.output<typeof deleteConnection.input>;
export type DeleteConnectionOutput = z.output<typeof deleteConnection.output>;
