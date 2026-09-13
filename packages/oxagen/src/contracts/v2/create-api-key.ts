import { z } from "zod";
import { defineTool } from "./_define";
import { apiKeyCreate } from "../api.key.create";

/**
 * Appendix E: `create_api_key` — "purpose-locked keys for humans and services".
 * Absorbs `create_api_key`.
 *
 * The name, expiry and once-only raw key all carry unchanged. The words that
 * make this more than a rename are "purpose-locked", and they come from §6.2:
 * an agent credential "is stored as a hash, **locked to one purpose**, and
 * revocable". Appendix A `iam.credentials` gives the column its vocabulary —
 * `purpose ∈ human, wrap_host, agent, service` alongside `kind ∈ api_key,
 * agent_credential, host_device_key, service_token`.
 *
 * v1 had no purpose. It had `scope: z.record(z.unknown())`, documented as
 * "reserved for future use" and defaulted to `{}`, which in practice meant every
 * key was unscoped and interchangeable: a key minted for a CI job could drive
 * the API as the person who created it. Purpose is what a revocation reasons
 * about ("revoke every wrap_host key") and what the broker checks before it
 * hands a credential to a run (§6.8). Required, with no default — a defaulted
 * purpose is an unlocked key wearing a lock's name.
 */
export const createApiKey = defineTool({
  name: "create_api_key",
  domain: "api_key",
  description:
    "Create an API key locked to one purpose (human, agent, wrap_host, or service). Returns the raw key once — it is never recoverable after this call. Audited as api_key.created.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["api", "docs", "mcp", "unit", "app"],
  scoped: true,

  absorbs: ["create_api_key"],
  drops: [
    {
      field: "scope",
      from: "create_api_key",
      why: "a free-form `z.record(z.unknown())` defaulted to `{}` and documented as 'reserved for future use' — it constrained nothing. Its job splits in two: `purpose` locks what kind of caller the key may be (§6.2, Appendix A iam.credentials.purpose), and the resource ceiling moves to the role grant's `resource_scope` (§6.3), which is the only place the resolver reads a ceiling from",
    },
  ],

  // Carried unchanged.
  agent: {
    requiresApproval: false,
    riskLevel: "medium",
    category: "organization",
  },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  // Carried: key management consumes no AI tokens, and an org at zero balance
  // must still be able to rotate its way out of a leak.
  noBillingGate: true,
  mutates: true,

  input: z.object({
    // Carried by reference, with the 1–120 bound and its `.describe()`.
    name: apiKeyCreate.input.shape.name,

    /**
     * Appendix A `iam.credentials.purpose`. Required and undefaulted: the whole
     * value of a purpose-locked key is that it cannot be used as another kind,
     * and a default would silently make every key a `human` one.
     */
    purpose: z.enum(["human", "agent", "wrap_host", "service"]),

    expiresAt: apiKeyCreate.input.shape.expiresAt,
  }),

  output: z.object({
    keyId: apiKeyCreate.output.shape.keyId,
    publicId: apiKeyCreate.output.shape.publicId,
    name: apiKeyCreate.output.shape.name,
    keyPrefix: apiKeyCreate.output.shape.keyPrefix,
    // Shown ONCE. Carried with its `.describe()` intact, because that string is
    // what a generated client's docs put in front of whoever has to save it.
    rawKey: apiKeyCreate.output.shape.rawKey,
    expiresAt: apiKeyCreate.output.shape.expiresAt,
    createdAt: apiKeyCreate.output.shape.createdAt,
    // Echoed so a caller listing keys later can match what it asked for
    // against what `list_connections`-style reads report.
    purpose: z.enum(["human", "agent", "wrap_host", "service"]),
    // Carried: the chat-render directive the app's token page uses to show the
    // key once in the conversation rather than in a toast that scrolls away.
    render: apiKeyCreate.output.shape.render,
  }),
});

export type CreateApiKeyInput = z.output<typeof createApiKey.input>;
export type CreateApiKeyOutput = z.output<typeof createApiKey.output>;
