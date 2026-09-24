import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * execute_scim_request: answer one SCIM 2.0 request an identity provider sent to
 * /api/scim/v2 (RFC 7643 and RFC 7644, #3734).
 *
 * The route authenticates the bearer token against `org.scim_tokens` and
 * invokes this with the token's id and the organization it names, so every
 * SCIM write runs through `invoke()` and the kernel's IAM check and audit row
 * apply. The handler checks the token again (live, and this organization's)
 * before it reads or writes anything.
 *
 * `surfaces` is empty: the SCIM route is the only caller, and it passes no
 * surface, the way the app's kernel seam calls `authorize_cli`. The context
 * carries no user and no API key, because the identity provider is neither;
 * the handler refuses a call that carries either. `defaultEffect` is `allow`
 * for the same reason: a principal-less call has no role to grant it, and the
 * token is the authorization.
 *
 * What it serves: ServiceProviderConfig, ResourceTypes and Schemas; Users
 * (GET with a `userName eq` filter, POST, and GET, PUT, PATCH, DELETE by id);
 * Groups (GET, POST, and GET, PUT, PATCH, DELETE by id). `active: false` and
 * DELETE deprovision a person: every session ended, every key and host
 * revoked, every role assignment and membership removed, in one transaction.
 * A group change recomputes the organization role of each person it touches
 * through `org.sso_group_roles`. An Owner is never deprovisioned or changed.
 */
export const scimRequest = registerCapability({
  name: "execute_scim_request",
  domain: "org",
  description:
    "Answer one SCIM 2.0 provisioning request from the organization's identity provider: create, update, deactivate or delete users and groups, and recompute organization roles from group membership through the SSO group mapping.",
  mode: "sync",
  surfaces: [],
  layers: ["schema", "unit", "docs"],
  scoped: false,
  sensitivity: "high",
  mutates: true,
  defaultEffect: "allow",
  defaultRoles: { org: {}, workspace: {} },
  noBillingGate: true,
  input: z.object({
    tokenId: z
      .string()
      .uuid()
      .describe("The org.scim_tokens row the route authenticated"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z
      .string()
      .max(512)
      .describe("The path after /api/scim/v2, starting with a slash"),
    query: z.record(z.string()).default({}),
    body: z.unknown().optional(),
  }),
  output: z.object({
    status: z.number().int().min(200).max(599),
    body: z.unknown().nullable(),
    location: z.string().optional(),
  }),
});

export type ScimRequestInput = z.output<typeof scimRequest.input>;
export type ScimRequestOutput = z.output<typeof scimRequest.output>;
