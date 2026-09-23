import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { orgSsoCreate } from "@oxagen/oxagen/contracts/org.sso.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

const shape = orgSsoCreate.input.shape;

export const schema = {
  ...shape,
  providerId: shape.providerId.describe(
    "Stable id for the provider, used in its callback URL: 2 to 63 lowercase letters, digits or hyphens",
  ),
  displayName: shape.displayName.describe(
    "The name people see on the sign-in button, up to 120 characters",
  ),
  domain: shape.domain.describe(
    "The email domain this provider signs people in for, such as acme.com. One domain has one provider",
  ),
  groupsClaim: shape.groupsClaim.describe(
    "The OIDC claim or SAML attribute that carries the person's groups. Defaults to groups",
  ),
  config: shape.config.describe(
    'Protocol settings. OIDC: { protocol: "oidc", issuer (https), clientId, clientSecret, scopes? }. SAML: { protocol: "saml", issuer (IdP entity id), entryPoint (https SSO URL), cert (PEM), spPrivateKey? (PEM) }. Secrets are envelope-encrypted and never returned',
  ),
};

export const metadata: ToolMetadata = {
  name: orgSsoCreate.name,
  description: orgSsoCreate.description,
  annotations: {
    readOnlyHint: false,
    // Registering the same provider id twice is a conflict, not a no-op.
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function orgSsoCreateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(orgSsoCreate.name, args, ctx, { surface: "mcp" });
  return orgSsoCreate.output.parse(output);
}
