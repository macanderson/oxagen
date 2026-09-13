import { z } from "zod";
import { defineTool } from "./_define";
import { connectionList } from "../connection.list";
import { modelCredentialViewSchema } from "../org.model_credential.shared";

const connectionRow = connectionList.output.shape.connections.element.shape;
const credentialView = modelCredentialViewSchema.shape;

/**
 * Appendix E: `list_connections` — "never returns secrets". Absorbs
 * `list_connections`, `list_secret_keys` and `get_model_credential`.
 *
 * **The redaction discipline is carried by import, not re-implemented.**
 * `get_model_credential`'s doc comment states the rule this whole tool has to
 * honour: "A read that echoed the key would turn every Owner/Admin token into a
 * copy of the customer's vendor credential." Its `modelCredentialViewSchema`
 * encodes what a safe answer looks like — `keyHint` is the last four
 * characters, the same thing a vendor dashboard shows — so `keyHint`,
 * `lastVerifiedAt` and `rotatedAt` are taken off that schema rather than
 * retyped. Retyping them is exactly how a redaction rule gets lost.
 *
 * **Two enums are replaced by Appendix A's, and both are tightenings.** v1's
 * `status` filter was the ingestion lifecycle (`pending_setup`, `connected`,
 * `paused`, `error`, `deleting`, `deleted`); `tools.connections.status` has
 * three values about the *credential* (`active`, `expired`, `revoked`). The
 * ingestion states did not move here — they moved to `list_sources`.
 *
 * **Internal ids stop crossing the boundary.** Both v1 list contracts returned
 * an internal `id` beside the public one. v2 returns `publicId` only. That is
 * stricter than either source, and it is deliberate: a uuid in a response is a
 * uuid in a log, a URL and a support ticket.
 */
export const listConnections = defineTool({
  name: "list_connections",
  domain: "tools",
  description:
    "List the workspace's connections with their kind, provider, credential status, test and rotation history, and which tool servers each backs. Never returns a secret — only the last four characters of a key.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  // Carried from `get_model_credential`: reading which vendors hold the org's
  // money is governance and consumes no tokens, and must work at zero balance.
  noBillingGate: true,

  absorbs: ["list_connections", "list_secret_keys", "get_model_credential"],
  renames: [
    {
      from: "connectorId",
      source: "list_connections",
      to: "provider",
      why: "Appendix A's `tools.connections.provider` replaces v1's connector-type slug. A connection now points at a model vendor or a GitHub App installation as readily as at an ingestion connector, and 'connector' named only the last of those. Carried by import (`connectionRow.connectorId`), so the filter semantics and the slug vocabulary are unchanged",
    },
  ],
  drops: [
    {
      field: "status (ingestion lifecycle)",
      from: "list_connections",
      why: "pending_setup/connected/paused/error/deleting/deleted describe an ingestion source, not a credential; Appendix A `tools.connections.status` is active/expired/revoked, and the ingestion states move to `list_sources`",
    },
    {
      field: "entityCount",
      from: "list_connections",
      why: "ingested-entity counts belong to the source, not the credential — Appendix E gives them to `list_sources` ('health, cursors, counts')",
    },
    {
      field: "lastSyncAt",
      from: "list_connections",
      why: "ingestion cursor — moves to `list_sources`",
    },
    {
      field: "healthStatus",
      from: "list_connections",
      why: "poll-loop health is a source fact; a connection's health is `status` plus `lastTestResult`, which are carried",
    },
    {
      field: "lastPollAt",
      from: "list_connections",
      why: "follows healthStatus into `list_sources`",
    },
    {
      field: "nextPollAt",
      from: "list_connections",
      why: "follows healthStatus into `list_sources`",
    },
    {
      field: "deliveryMethod",
      from: "list_connections",
      why: "how a source delivers records is ingestion configuration — moves to `list_sources`",
    },
    {
      field: "authScheme",
      from: "list_connections",
      why: "superseded by Appendix A's `kind`, which has to describe cloud roles and GitHub App installations as well as auth schemes",
    },
    {
      field: "id",
      from: "list_connections",
      why: "internal uuid: v2 exposes `publicId` only, which is stricter than either list source and keeps database identifiers out of logs and URLs",
    },
    {
      field: "id",
      from: "list_secret_keys",
      why: "same tightening",
    },
    {
      field: "sensitive",
      from: "list_secret_keys",
      why: "every connection secret is envelope-encrypted, so the flag has one value; see `set_connection`, where the input side of it is dropped for the same reason",
    },
    {
      field: "memo",
      from: "list_secret_keys",
      why: "Appendix A replaces the free-text note with `owner_user_id` and `review_at`, both accountability fields",
    },
    {
      field: "hasDefault",
      from: "list_secret_keys",
      why: "Appendix E drops the environment family, so there is no default-versus-override distinction left to report",
    },
    {
      field: "overrideEnvironmentIds",
      from: "list_secret_keys",
      why: "same: no per-environment override tier exists in v2",
    },
    {
      field: "configured",
      from: "get_model_credential",
      why: "the org-singleton's way of saying 'no row'. In a list, the row's presence is the answer — and there can now be several model-provider connections, so a single boolean could not describe them",
    },
    {
      field: "status (credential enabled/disabled)",
      from: "get_model_credential",
      why: "the active/disabled pair widens into Appendix A's active/expired/revoked; `expired` is the state v1 could not express and the one that actually breaks a run",
    },
  ],

  /**
   * All three sources agree on `{ requiresApproval: false, riskLevel: "low" }`.
   * The category is taken from `get_model_credential` ("configuration") rather
   * than the other two ("read"/"introspection") because it is the source that
   * sets the sensitivity below, and the two should describe the same thing.
   */
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "configuration",
  },
  // From `get_model_credential`, the strictest of the three (`medium` and
  // `low` from the others). The row set names every vendor holding the
  // organisation's money, which is worth classifying by what it reveals rather
  // than by the fact that it is a list.
  sensitivity: "high",
  defaultEffect: "deny",
  /**
   * From `get_model_credential`, again the strictest: an EMPTY workspace map
   * against `{ Owner, Member }` on both list sources.
   *
   * **Flagged for the cutover review (#2884):** this is the carry rule applied
   * literally, and it means a workspace Member cannot see the Toolbelt page's
   * connection list at all. If the reviewer decides the redacted view is safe
   * for members, the grant to add is workspace Owner/Member — but it should be
   * added deliberately, not inherited by accident.
   */
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  /**
   * All three handlers were read: `connection.list.ts`, `secret.key.list.ts`
   * and `org.model_credential.get.ts` are selects with no insert, update or
   * delete between them.
   */
  mutates: false,

  input: z.object({
    /** Appendix A `tools.connections.kind`. New as a filter — v1 had three
     * separate contracts instead of one filter. */
    kind: z
      .enum(["oauth", "api_key", "cloud_role", "github_app", "model_provider"])
      .optional()
      .describe("Filter by connection kind"),

    // Carried from `list_connections`: v1's connector-type slug is v2's
    // provider, and the filter semantics are unchanged.
    provider: connectionRow.connectorId
      .optional()
      .describe("Filter by provider slug (e.g. openrouter, github, slack)"),

    /** Appendix A `tools.connections.status`. */
    status: z
      .enum(["active", "expired", "revoked"])
      .optional()
      .describe("Filter by credential status"),
  }),

  output: z.object({
    connections: z.array(
      z.object({
        publicId: connectionRow.publicId,
        // v1's `displayName`; the column is `name`, and `set_connection` takes
        // `name`, so the read and the write agree.
        name: connectionRow.displayName,

        kind: z.enum([
          "oauth",
          "api_key",
          "cloud_role",
          "github_app",
          "model_provider",
        ]),
        provider: connectionRow.connectorId,
        status: z.enum(["active", "expired", "revoked"]),

        /**
         * Carried off `modelCredentialViewSchema` so the redaction rule travels
         * with the field. Last four characters only — enough to tell two keys
         * apart, which is the whole operator need, and never enough to use.
         */
        keyHint: credentialView.keyHint,
        lastVerifiedAt: credentialView.lastVerifiedAt,
        rotatedAt: credentialView.rotatedAt,

        /**
         * Appendix A `last_test_result`. `set_connection` tests before every
         * save, so this is the stored counterpart of that call's inline result
         * — the reason an operator can see a key went bad without re-testing
         * it.
         */
        lastTestResult: z.string().nullable(),

        /**
         * Appendix A `requires_mandate`: true when any tool this connection
         * backs carries a consequence tag (§6.9). Surfaced here because it is
         * what tells an operator that granting the connection is not the last
         * step — a mandate is still needed before a call using it can proceed.
         */
        requiresMandate: z.boolean(),

        /** The `tool_servers.connection_id` join, read from this side: which
         * servers stop working if this connection is revoked. */
        toolServerIds: z.array(z.string()),

        createdAt: connectionRow.createdAt,
      }),
    ),
  }),
});

export type ListConnectionsInput = z.output<typeof listConnections.input>;
export type ListConnectionsOutput = z.output<typeof listConnections.output>;
