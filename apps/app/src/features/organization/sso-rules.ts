// What the Single sign-on forms need to know about the contract, without
// loading it into the browser: the two protocols, the roles an IdP group may
// grant, and which fields each protocol asks for. `sso.test.tsx` holds these
// lists to `org.sso.shared`, so the forms cannot offer a value the contract
// refuses.
//
// No `owner` in the roles: ownership is transferred by a person, never minted
// by an identity provider (ADR-144).
import type { SsoMappableRole, SsoProtocol } from "@/data/contracts/org";

export const SSO_PROTOCOLS: readonly SsoProtocol[] = ["oidc", "saml"];

/** Highest rank first, the order the role select lists them in. */
export const SSO_ROLES: readonly SsoMappableRole[] = [
  "admin",
  "compliance",
  "billing",
  "member",
];

export function isSsoProtocol(value: string): value is SsoProtocol {
  return SSO_PROTOCOLS.some((p) => p === value);
}

export function isSsoRole(value: string): value is SsoMappableRole {
  return SSO_ROLES.some((r) => r === value);
}

/** The groups claim a provider reads when the admin names none. */
export const DEFAULT_GROUPS_CLAIM = "groups";
