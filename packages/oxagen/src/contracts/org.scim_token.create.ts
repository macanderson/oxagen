import { z } from "zod";
import { registerCapability } from "../registry";
import { scimTokenMintedSchema } from "./org.scim_token.shared";

/**
 * create_scim_token: mint the bearer token the organization's identity
 * provider pushes users and groups with (#3734).
 *
 * The answer carries the token once. Oxagen keeps only its SHA-256, so a lost
 * token is replaced with `rotate_scim_token`, never read back. One live token
 * per organization: minting while one exists is a conflict, and rotating is
 * the way to replace it.
 *
 * Org Owner/Admin only, Enterprise only (SCIM is part of single sign-on,
 * ADR-145), audited as `scim.token_created`. Not on MCP: a token in a tool
 * result lands in an agent's transcript and in Tacho's record of the call.
 */
export const orgScimTokenCreate = registerCapability({
  name: "create_scim_token",
  domain: "org",
  description:
    "Mint the organization's SCIM bearer token, which an identity provider such as Okta or Microsoft Entra ID uses to push users and groups to Oxagen. The token is returned once; only its hash is stored. Fails when a live token already exists; rotate it instead.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: false,
  sensitivity: "high",
  mutates: true,
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  noBillingGate: true,
  input: z.object({}),
  output: scimTokenMintedSchema,
});

export type OrgScimTokenCreateInput = z.output<typeof orgScimTokenCreate.input>;
export type OrgScimTokenCreateOutput = z.output<
  typeof orgScimTokenCreate.output
>;
