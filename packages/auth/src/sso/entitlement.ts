/**
 * Whether an organisation's plan includes single sign-on (ADR-145: SSO is an
 * Enterprise feature). The sign-in side reads it twice:
 *   - an SSO sign-in into an organisation without it is refused, so a
 *     downgrade turns SSO off rather than leaving it half on;
 *   - "Require SSO" does not apply to such an organisation, so a downgrade
 *     cannot lock its members out of every sign-in method at once.
 *
 * The configuration side (the org.sso.* capabilities) gates on the same
 * canAccessSSO check.
 */
import { canAccessSSO, resolveOrgTier } from "@oxagen/billing";

export async function orgHasSso(orgId: string): Promise<boolean> {
  return canAccessSSO(await resolveOrgTier(orgId));
}
