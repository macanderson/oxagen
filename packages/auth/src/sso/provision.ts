/**
 * What an SSO sign-in grants (ADR-145).
 *
 * The @better-auth/sso plugin calls `provisionUser` after it has verified the
 * identity provider's assertion and found or created the user, and before it
 * sets the session cookie. This module turns the IdP's groups into the
 * person's organisation role through the table an admin edits on the Roles
 * page, and records the sign-in as an `sso.sign_in` security event.
 *
 * The rules, in order:
 *   1. An Owner is never changed by SSO. Ownership is transferred by a person,
 *      and an IdP misconfiguration must not be able to demote the last Owner.
 *   2. Otherwise the highest-ranked role any of the person's groups maps to
 *      REPLACES their org role. The mapping is authoritative on every sign-in,
 *      so removing someone from an IdP group takes effect at their next
 *      sign-in rather than never.
 *   0. The organisation's plan must include SSO (Enterprise). A sign-in into
 *      one that does not is refused and recorded with `outcome: "deny"`, so a
 *      downgrade turns SSO off rather than leaving it half on.
 *   3. Deny by default. A group with no mapping grants nothing; a person none
 *      of whose groups is mapped is left with no role in the organisation, and
 *      the event is recorded with `outcome: "deny"`.
 *
 * Failure is closed: if the mapping cannot be read or applied, the error
 * propagates and the plugin never sets the session cookie, so the person is
 * not signed in with a role the mapping did not decide.
 *
 * The Postgres work is injected (`SsoProvisioningStore`) so the sign-in can be
 * proven end to end against an in-memory store; `pg-store.ts` is the real one.
 */
import {
  normalizeSsoGroups,
  resolveSsoGrantedRole,
  type SsoGroupRole,
  type SsoMappableRole,
} from "@oxagen/oxagen/contracts/org.sso.shared";
import type { SecurityEventInput } from "@oxagen/telemetry";

/** The IdP groups kept on the audit row, so a hostile token cannot bloat it. */
const MAX_AUDITED_GROUPS = 50;

/** Thrown when the organisation's plan does not include SSO. */
export class SsoNotEntitledError extends Error {
  constructor(readonly orgId: string) {
    super("Single sign-on is part of the Enterprise plan");
    this.name = "SsoNotEntitledError";
  }
}

export interface SsoProvisioningStore {
  /** Whether the organisation's plan includes SSO. */
  entitled(orgId: string): Promise<boolean>;
  /** The group → role rows for one provider of one organisation. */
  groupRoles(orgId: string, providerId: string): Promise<SsoGroupRole[]>;
  /** The person's current org role, lowercase, or null when not a member. */
  currentRole(orgId: string, userId: string): Promise<string | null>;
  /**
   * Make `role` the person's org role, creating the membership when absent;
   * `null` removes their org role and membership. Atomic.
   */
  applyRole(args: {
    orgId: string;
    userId: string;
    role: SsoMappableRole | null;
    providerId: string;
  }): Promise<void>;
}

export interface SsoProvisionerDeps {
  store: SsoProvisioningStore;
  emit: (event: SecurityEventInput) => void;
}

/** The slice of the plugin's `provisionUser` argument this module reads. */
export interface SsoProvisionInput {
  user: { id: string; email?: string | null };
  userInfo: Record<string, unknown>;
  provider: { providerId: string; organizationId?: string | null };
}

export type SsoProvisionOutcome = {
  grantedRole: SsoMappableRole | "owner" | null;
  previousRole: string | null;
  reason: "mapped" | "no_mapped_group" | "owner_unmanaged";
};

/**
 * Build the plugin's `provisionUser` callback. Register it with
 * `provisionUserOnEveryLogin: true`, or rule 2 only runs on first sign-in.
 */
export function createSsoProvisioner(deps: SsoProvisionerDeps) {
  return async function provisionSsoUser(
    input: SsoProvisionInput,
  ): Promise<SsoProvisionOutcome> {
    const { user, userInfo, provider } = input;
    const orgId = provider.organizationId;
    if (!orgId) {
      // Every Oxagen provider row carries its organisation (NOT NULL). A row
      // without one was not written by the org.sso.* capabilities, so it
      // grants nothing and the sign-in fails rather than guessing.
      throw new Error(
        `SSO provider ${provider.providerId} has no organization; refusing to provision`,
      );
    }
    const groups = normalizeSsoGroups(userInfo.groups);
    const auditedGroups = groups.slice(0, MAX_AUDITED_GROUPS);

    let previousRole: string | null = null;
    try {
      if (!(await deps.store.entitled(orgId))) {
        deps.emit(
          signInEvent(orgId, user.id, "deny", {
            providerId: provider.providerId,
            groups: auditedGroups,
            grantedRole: null,
            previousRole: null,
            reason: "not_entitled",
          }),
        );
        throw new SsoNotEntitledError(orgId);
      }
      previousRole = await deps.store.currentRole(orgId, user.id);

      if (previousRole === "owner") {
        deps.emit(
          signInEvent(orgId, user.id, "success", {
            providerId: provider.providerId,
            groups: auditedGroups,
            grantedRole: "owner",
            previousRole,
            reason: "owner_unmanaged",
          }),
        );
        return {
          grantedRole: "owner",
          previousRole,
          reason: "owner_unmanaged",
        };
      }

      const mappings = await deps.store.groupRoles(orgId, provider.providerId);
      const granted = resolveSsoGrantedRole(groups, mappings);

      if (
        granted !== previousRole &&
        (granted !== null || previousRole !== null)
      ) {
        await deps.store.applyRole({
          orgId,
          userId: user.id,
          role: granted,
          providerId: provider.providerId,
        });
      }

      const reason = granted ? "mapped" : "no_mapped_group";
      deps.emit(
        signInEvent(orgId, user.id, granted ? "success" : "deny", {
          providerId: provider.providerId,
          groups: auditedGroups,
          grantedRole: granted,
          previousRole,
          reason,
        }),
      );
      return { grantedRole: granted, previousRole, reason };
    } catch (err) {
      if (err instanceof SsoNotEntitledError) throw err;
      deps.emit(
        signInEvent(orgId, user.id, "error", {
          providerId: provider.providerId,
          groups: auditedGroups,
          grantedRole: null,
          previousRole,
          reason: "provision_failed",
        }),
      );
      throw err;
    }
  };
}

function signInEvent(
  orgId: string,
  userId: string,
  outcome: SecurityEventInput["outcome"],
  detail: {
    providerId: string;
    groups: readonly string[];
    grantedRole: string | null;
    previousRole: string | null;
    reason:
      | "mapped"
      | "no_mapped_group"
      | "owner_unmanaged"
      | "not_entitled"
      | "provision_failed";
  },
): SecurityEventInput {
  return {
    eventType: "sso.sign_in",
    actorUserId: userId,
    orgId,
    workspaceId: null,
    capability: null,
    outcome,
    ip: null,
    userAgent: null,
    requestId: null,
    detail,
  };
}
