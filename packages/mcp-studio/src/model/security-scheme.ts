// security-scheme.ts: how a credential is applied to a request.
//
// server.toml's auth.scheme names a scheme. For OpenAPI it is a key of the
// document's components.securitySchemes, and the document says what the key
// means. For every other source it is oauth, bearer, basic, or header. The
// gateway never reads the document, so import copies each scheme into the
// lock, and compile resolves the one server.toml names into the manifest.
import { z } from "zod";
import { uniqueList, withChecks } from "../contract/checks";
import { httpUrlSchema } from "../contract/primitives";

export const SECURITY_SCHEME_TYPES = [
  "oauth2",
  "openIdConnect",
  "http_bearer",
  "http_basic",
  "api_key",
  "mutual_tls",
] as const;
export type SecuritySchemeType = (typeof SECURITY_SCHEME_TYPES)[number];

export const securitySchemeSchema = withChecks(
  z
    .object({
      type: z.enum(SECURITY_SCHEME_TYPES),
      in: z
        .enum(["header", "query", "cookie"])
        .optional()
        .describe("Where an API key goes. api_key only."),
      name: z
        .string()
        .min(1)
        .max(256)
        .optional()
        .describe("The header, query parameter, or cookie that carries an API key. api_key only."),
      authorization_url: httpUrlSchema
        .optional()
        .describe("oauth2: the authorization code flow's authorizationUrl."),
      token_url: httpUrlSchema
        .optional()
        .describe("oauth2: the tokenUrl of the authorization code or client credentials flow."),
      refresh_url: httpUrlSchema.optional().describe("oauth2: the refreshUrl, when it differs from token_url."),
      openid_connect_url: httpUrlSchema.optional().describe("openIdConnect: the discovery document."),
      scopes: uniqueList(z.string().min(1).max(256), "scopes", 256)
        .optional()
        .describe("oauth2 and openIdConnect: the scopes the flow offers."),
    })
    .strict(),
  [
    { kind: "require", when: { field: "type", is: "api_key" }, fields: ["in", "name"] },
    { kind: "forbid", when: { field: "type", isNot: "api_key" }, fields: ["in", "name"] },
    { kind: "require", when: { field: "type", is: "openIdConnect" }, fields: ["openid_connect_url"] },
  ],
);
export type SecurityScheme = z.output<typeof securitySchemeSchema>;

/**
 * The scheme a non-OpenAPI auth.scheme means: oauth, bearer, basic, or header.
 * A remote MCP server's OAuth endpoints come from its own metadata at connect
 * time, so the oauth2 scheme here names none.
 */
export function builtinSecurityScheme(
  scheme: "oauth" | "bearer" | "basic" | "header",
  header: string | undefined,
): SecurityScheme {
  switch (scheme) {
    case "oauth":
      return { type: "oauth2" };
    case "bearer":
      return { type: "http_bearer" };
    case "basic":
      return { type: "http_basic" };
    case "header":
      if (header === undefined) throw new TypeError("auth.header is required when scheme is header");
      return { type: "api_key", in: "header", name: header };
  }
}
