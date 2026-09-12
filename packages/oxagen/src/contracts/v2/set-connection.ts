import { z } from "zod";
import { defineTool } from "./_define";
/**
 * `set_model_credential` and `verify_model_credential` both compose their own
 * input and output from this shared module, precisely so no surface can drift
 * on what a credential looks like. Importing it here rather than either
 * contract is therefore the same carry, one hop closer to the source.
 */
import {
  modelCredentialApiKeySchema,
  modelCredentialVerificationSchema,
} from "../org.model_credential.shared";
import { pluginCredentialSetSecret } from "../plugin.credential.set_secret";
import { pluginCredentialReauth } from "../plugin.credential.reauth";

/**
 * Appendix E: `set_connection` — "credential to a tool server or provider,
 * tested before save". Absorbs `set_model_credential`,
 * `verify_model_credential`, `upsert_secret_key`, `set_secret_value`,
 * `set_plugin_secret` and `reauth_plugin_credential`.
 *
 * **Six contracts collapse because Appendix A gives them one table.** A model
 * vendor key, a vault secret, and a plugin's OAuth tokens were three storage
 * shapes with three id spaces; `tools.connections` has one row per credential
 * with a `kind` discriminator (`oauth`, `api_key`, `cloud_role`, `github_app`,
 * `model_provider`). Every per-source id — `keyId`, `orgListingId`, the
 * org-singleton model credential — becomes one optional `connectionId`, and its
 * presence is what makes the call an update rather than a create.
 *
 * **"Tested before save" is not a flag.** `verify_model_credential` was a
 * separate button. Here the vendor check is unconditional and its result is
 * returned inline, so `last_tested_at`/`last_test_result` (Appendix A) can never
 * describe a credential that was never tested. That also absorbs verify's
 * second mode for free: a call with `connectionId` and no new secret re-tests
 * what is stored, which is what a health sweep does.
 *
 * **The in-app agent cannot call this, on purpose.** Four of the six sources
 * declared `agent` metadata; the two model-credential contracts deliberately
 * declared none, with the rationale that "the in-app agent must never be able
 * to set the key that funds its own turns". That is the strictest available
 * posture — not merely a higher risk level, but absence from the belt entirely
 * — so it carries, and `surfaces` drops `"agent"` to match.
 */
export const setConnection = defineTool({
  name: "set_connection",
  domain: "tools",
  description:
    "Create or update a connection — the credential that backs a tool server or a model provider. The credential is tested against the provider before it is stored, envelope-encrypted at rest, and never readable back. Returns the test result and the redacted connection.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  /**
   * Carried from `set_model_credential`, whose reason generalises to every
   * connection: deciding who pays, or repairing an expired key, is governance
   * and consumes no AI tokens. Gating it would lock an org out of the one
   * action that fixes a zero balance.
   */
  noBillingGate: true,

  absorbs: [
    "set_model_credential",
    "verify_model_credential",
    "upsert_secret_key",
    "set_secret_value",
    "set_plugin_secret",
    "reauth_plugin_credential",
  ],
  renames: [
    {
      from: "apiKey",
      source: "set_model_credential",
      to: "secret",
      why: "one row, one piece of secret material: a model-vendor key, a vault value and a cloud role credential all land in Appendix A's `secret_ciphertext`, and `apiKey` named only the first. Carried by import of `modelCredentialApiKeySchema`, so the learned 8–512 bound travels with it",
    },
    {
      from: "apiKey",
      source: "verify_model_credential",
      to: "secret",
      why: "same field, same schema, reached through verify's candidate-key mode — which this tool absorbs by testing unconditionally before save rather than behind a second call",
    },
    {
      from: "value",
      source: "set_secret_value",
      to: "secret",
      why: "the vault's per-environment value becomes the connection's own secret once the environment tier is dropped (see drops). `set_secret_value` typed it as a bare `z.string()`; the carried `modelCredentialApiKeySchema` is the stricter of the two, and the stricter wins",
    },
    {
      from: "key",
      source: "upsert_secret_key",
      to: "name",
      why: "a vault secret key is a connection row now, and the workspace-unique label it was looked up by is Appendix A's `tools.connections.name`. The word `key` could not survive the collapse: in a table whose columns include `key_id` and whose rows hold API keys, it would name three things at once",
    },
  ],
  drops: [
    {
      field: "environmentId",
      from: "set_secret_value",
      why: "Appendix E drops the environment family outright ('environment.* and bind/unbind_agent_environment (no runtime)'), so there is no per-environment override tier for a value to belong to",
    },
    {
      field: "defaultValue",
      from: "upsert_secret_key",
      why: "follows environmentId: a default only means something against overrides, and with the override tier gone the connection's own secret is the only value",
    },
    {
      field: "sensitive",
      from: "upsert_secret_key",
      why: "every connection secret is envelope-encrypted (Appendix A `secret_ciphertext`, `key_id`, `digest`) — a non-sensitive key was configuration, not a credential, and Appendix E's dropped list records that 'secrets are connections and are never revealed'",
    },
    {
      field: "memo",
      from: "upsert_secret_key",
      why: "Appendix A gives tools.connections accountability fields instead of a free-text note: `owner_user_id` (the accountable person) and `review_at`",
    },
    {
      field: "keyId",
      from: "set_secret_value",
      why: "one id space: tools.connections replaces the vault key, the plugin listing and the org credential singleton, so keyId, orgListingId and the implicit org key all become connectionId",
    },
    {
      field: "orgListingId",
      from: "set_plugin_secret",
      why: "same collapse — a plugin's credential is a connection row; Appendix E also drops the plugin marketplace family ('no marketplace in v1; sources and tool servers replace it')",
    },
    {
      field: "orgListingId",
      from: "reauth_plugin_credential",
      why: "same collapse; re-auth is now `set_connection` on an existing connectionId with no new secret, which returns a fresh authorizeUrl when the kind is oauth",
    },
    {
      field: "authKind",
      from: "set_plugin_secret",
      why: "the two-value oauth/secret discriminator widens into Appendix A's five-value `kind`, which also has to describe cloud roles, GitHub App installations and model providers",
    },
  ],

  /**
   * No `agent` metadata, carried from `set_model_credential` and
   * `verify_model_credential`. The other four sources did declare it (the
   * strictest of those being `{ requiresApproval: true, riskLevel: "high" }`
   * from `set_plugin_secret`), but "not an agent tool at all" is stricter than
   * any risk level, and the reason given in v1 still holds: an agent that can
   * mint the credential funding its own turns has no ceiling.
   */
  sensitivity: "high",
  defaultEffect: "deny",
  // All six agree: org Owner/Admin, and an EMPTY workspace map. A workspace
  // role must never reach a credential the whole org pays for or is liable for.
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  // Writes tools.connections (ciphertext + digest) and stamps the test result.
  mutates: true,

  input: z.object({
    /**
     * Omit to create; supply to update. Supplying it with no secret material is
     * the re-test path absorbed from `verify_model_credential`'s no-argument
     * mode, and the re-auth path absorbed from `reauth_plugin_credential`.
     */
    connectionId: z.string().min(1).optional(),

    /**
     * Appendix A `tools.connections.name`. `upsert_secret_key`'s `key` is
     * carried here (see renames) and is the only one of the six sources that
     * named its credential — every other one was implicitly the only
     * credential of its type, so it needed no name. A workspace with three
     * api_key connections needs to tell them apart, and a vault key's name is
     * exactly the workspace-unique label that does it.
     */
    name: z.string().min(1).max(120),

    /** Appendix A `tools.connections.kind`. Replaces three source-specific
     * discriminators: plugin `authKind`, the model-credential provider enum,
     * and the vault key's `sensitive` flag. */
    kind: z.enum([
      "oauth",
      "api_key",
      "cloud_role",
      "github_app",
      "model_provider",
    ]),

    /**
     * Appendix A `tools.connections.provider` is free text because a connection
     * can point at any vendor. The closed `modelCredentialProviderSchema`
     * (`openrouter`, `gateway`) still governs which values are legal when
     * `kind` is `model_provider` — enforced in the handler rather than as a
     * refinement here, so `.shape` stays reachable for the MCP parameter
     * builder (the same reason `verify_model_credential` exported its base
     * object separately).
     */
    provider: z.string().min(1).max(120),

    /**
     * The secret for an `api_key`, `cloud_role` or `model_provider`
     * connection. Carried by reference from the model-credential schema, whose
     * 8–512 bound is the learned part: the lower bound rejects an empty paste
     * before anything is encrypted, the upper keeps a hostile value from
     * inflating a log line or a ciphertext. `set_secret_value` accepted a bare
     * `z.string()`, so this is a tightening — the stricter of two sources wins.
     */
    secret: modelCredentialApiKeySchema.optional(),

    // Carried from `set_plugin_secret` for `kind: "oauth"`. The refresh token
    // is stored and never read back — `list_connections` cannot return it and
    // neither can this call's own output.
    accessToken: pluginCredentialSetSecret.input.shape.accessToken,
    refreshToken: pluginCredentialSetSecret.input.shape.refreshToken,

    /**
     * Appendix A `tools.tool_servers.connection_id` seen from the other end:
     * binding at set time is what lets `register_tool_server` stay
     * credential-free. Optional because a model-provider connection backs no
     * server.
     */
    toolServerId: z.string().min(1).optional(),
  }),

  output: z.object({
    connectionId: z.string(),
    name: z.string(),
    kind: z.enum([
      "oauth",
      "api_key",
      "cloud_role",
      "github_app",
      "model_provider",
    ]),
    provider: z.string(),
    status: z.enum(["active", "expired", "revoked"]),

    /**
     * The unconditional pre-save check, carried whole from
     * `verify_model_credential`. `ok: false` carries the provider's own message
     * about the credential — never the credential — because a generic failure
     * gives an operator nothing to fix. `provider` is dropped from the carried
     * shape for the same reason the input's is free text.
     */
    test: z.object({
      ok: modelCredentialVerificationSchema.shape.ok,
      latencyMs: modelCredentialVerificationSchema.shape.latencyMs,
      error: modelCredentialVerificationSchema.shape.error,
    }),

    /**
     * Carried from `reauth_plugin_credential`. Non-null only when the
     * connection needs a browser hop to complete — an OAuth connection created
     * without tokens, or one whose grant was revoked upstream. The caller
     * deep-links the user into consent; nothing is usable until they return.
     */
    authorizeUrl: pluginCredentialReauth.output.shape.authorizeUrl.nullable(),

    /**
     * Appendix A `last_tested_at`. Redundant with `test` on this call and not
     * on any later read, which is the point: the column and the response are
     * written from the same clock.
     */
    lastTestedAt: z.string(),
  }),
});

export type SetConnectionInput = z.output<typeof setConnection.input>;
export type SetConnectionOutput = z.output<typeof setConnection.output>;
