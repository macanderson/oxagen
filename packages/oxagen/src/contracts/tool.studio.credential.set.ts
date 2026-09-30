import { z } from "zod";
import { registerCapability } from "../registry";
import { CREDENTIAL_NAME_PATTERN } from "../steering-repo/names";

/**
 * Studio's named credentials (mcp-studio-spec, Authentication). A server.toml
 * environment names a credential as `oxagen:credential/<name>`, and this
 * capability stores the value behind that name: a service secret, such as an
 * API key, or the id and secret of an OAuth client. Oxagen seals each secret
 * before it writes the row, and no response or log line carries one.
 */

/** The longest secret the vault takes, in characters. */
export const STUDIO_CREDENTIAL_SECRET_MAX = 8192;
/** The longest OAuth client id the vault takes, in characters. */
export const STUDIO_CREDENTIAL_CLIENT_ID_MAX = 512;

/** A credential's name: the <name> in `oxagen:credential/<name>`. */
export const studioCredentialNameSchema = z
  .string()
  .regex(
    CREDENTIAL_NAME_PATTERN,
    "a credential name is up to 63 lowercase letters, digits, and hyphens, and starts with a letter or digit",
  );

/**
 * The input's base object, before the rule that ties each field to a kind:
 * the MCP tool spreads `.shape` for its argument schema, and a refined schema
 * has none. `invoke()` re-parses the refined contract input, so the rule still
 * holds on a call.
 */
export const toolStudioCredentialSetInputObject = z
  .object({
    /** The <name> in `oxagen:credential/<name>`. */
    name: studioCredentialNameSchema,
    /** secret for a service secret, oauth_client for an OAuth client's id and secret. */
    kind: z.enum(["secret", "oauth_client"]),
    /** The service secret. Required for kind secret, refused for oauth_client. */
    secret: z.string().min(1).max(STUDIO_CREDENTIAL_SECRET_MAX).optional(),
    /** The OAuth client id. Required for kind oauth_client, refused for secret. */
    clientId: z.string().min(1).max(STUDIO_CREDENTIAL_CLIENT_ID_MAX).optional(),
    /** The OAuth client secret. Required for kind oauth_client, refused for secret. */
    clientSecret: z.string().min(1).max(STUDIO_CREDENTIAL_SECRET_MAX).optional(),
  })
  .strict();

type CredentialSetFields = z.output<typeof toolStudioCredentialSetInputObject>;

/** Each field the kind requires is present, and each field it refuses is absent. */
function checkFieldsForKind(input: CredentialSetFields, ctx: z.RefinementCtx): void {
  const required: (keyof CredentialSetFields)[] =
    input.kind === "secret" ? ["secret"] : ["clientId", "clientSecret"];
  const refused: (keyof CredentialSetFields)[] =
    input.kind === "secret" ? ["clientId", "clientSecret"] : ["secret"];
  for (const field of required) {
    if (input[field] === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `kind ${input.kind} needs ${field}`,
      });
    }
  }
  for (const field of refused) {
    if (input[field] !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `kind ${input.kind} takes no ${field}`,
      });
    }
  }
}

export const toolStudioCredentialSet = registerCapability({
  name: "set_mcp_credential",
  domain: "tool",
  description:
    "Create or replace a named credential in this workspace: a service secret, or an OAuth client's id and secret. A server.toml environment names it as oxagen:credential/<name>. Oxagen seals each secret, and the response names only the credential.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  // Storing a credential spends no model tokens.
  noBillingGate: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "plugin" },
  sensitivity: "high",
  mutates: true,
  defaultEffect: "deny",
  // The roles set_plugin_secret grants: a stored credential hands a remote
  // account to whoever supplied it, so only an org Owner or Admin writes one.
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  audit: { targetKind: "mcp_credential", targetIdField: "name" },
  input: toolStudioCredentialSetInputObject.superRefine(checkFieldsForKind),
  output: z.object({
    name: z.string(),
    /** `oxagen:credential/<name>`, as server.toml names it. */
    reference: z.string(),
    /** True when this call created the credential, false when it replaced one. */
    created: z.boolean(),
  }),
});

export type ToolStudioCredentialSetInput = z.output<typeof toolStudioCredentialSet.input>;
export type ToolStudioCredentialSetOutput = z.output<typeof toolStudioCredentialSet.output>;
