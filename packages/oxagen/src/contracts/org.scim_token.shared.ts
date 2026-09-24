import { z } from "zod";

/**
 * Shared wire schemas for SCIM provisioning (#3734). Not a capability itself:
 * the token contracts, `list_sso_providers` and the app import from here.
 */

/** What the Single sign-on page shows about the organization's SCIM token. */
export const scimTokenViewSchema = z.object({
  tokenPrefix: z
    .string()
    .describe("The token's first characters, to tell one token from the next"),
  createdAt: z.string().describe("ISO timestamp the token was minted"),
  lastUsedAt: z
    .string()
    .nullable()
    .describe("ISO timestamp of the last SCIM request it authenticated"),
});
export type ScimTokenView = z.infer<typeof scimTokenViewSchema>;

/** The organization's SCIM endpoint and its live token, if one exists. */
export const scimViewSchema = z.object({
  baseUrl: z
    .string()
    .describe("The SCIM 2.0 base URL to enter in the identity provider"),
  token: scimTokenViewSchema.nullable(),
});
export type ScimView = z.infer<typeof scimViewSchema>;

/** The answer to minting or rotating: the token, shown once and never again. */
export const scimTokenMintedSchema = z.object({
  token: z
    .string()
    .describe(
      "The bearer token. Oxagen stores only its hash, so this is the one time it can be read.",
    ),
  baseUrl: z.string(),
  view: scimTokenViewSchema,
});
