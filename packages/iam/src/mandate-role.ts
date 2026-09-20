// mandate-role.ts — the role gates a mandate's consequences and approval rule
// put on a caller (MC spec §6.9, ADR-059 decision 1).
//
// A consequence tag names the org roles accountable for it: the workspace's
// `consequence_roles` override first, the defaults in
// `@oxagen/oxagen/mandates/schemas` otherwise. Granting, changing or revoking
// a mandate, answering a call its approval rule parked, and changing a tool's
// safety classification all need a role named for every tag involved. A
// mandate's `approval.approvers`, when it names any, narrows who may answer
// to those entries.
//
// These live beside `assertOrgRole` so `packages/handlers` and
// `packages/agent`, which both depend on this package and not on each other,
// run the same check (apps/app/ARCHITECTURE.md §3.2, INV-29).

import { schema, withTenantDb, type Tx } from "@oxagen/database";
import { HandlerError, isHandlerError } from "@oxagen/oxagen";
import {
  consequenceRolesSchema,
  rolesForConsequence,
  type ConsequenceRoles,
  type OrgRoleName,
} from "@oxagen/oxagen/mandates/schemas";
import { eq } from "drizzle-orm";
import {
  assertOrgRole,
  resolveActingUserId,
  type ActingCredential,
  type OrgRoleActor,
} from "./org-role";

/** The context fields these gates read: the role actor and its credential. */
type MandateRoleActor = OrgRoleActor & ActingCredential;

/** The workspace's consequence-role overrides, parsed; `{}` when unset or malformed. */
export async function loadConsequenceRoles(
  tx: Tx,
  workspaceId: string,
): Promise<ConsequenceRoles> {
  const row = await tx.query.workspaces.findFirst({
    where: eq(schema.workspaces.id, workspaceId),
    columns: { consequenceRoles: true },
  });
  const parsed = consequenceRolesSchema.safeParse(row?.consequenceRoles ?? {});
  return parsed.success ? parsed.data : {};
}

/**
 * The roles accountable for `tags` together: the roles named for every tag
 * at once. A mandate over two consequences needs authority over both.
 */
export function rolesForAllTags(
  tags: readonly string[],
  overrides: ConsequenceRoles,
): OrgRoleName[] {
  let roles: readonly OrgRoleName[] | null = null;
  for (const tag of tags) {
    const forTag = rolesForConsequence(tag, overrides);
    roles = roles === null ? forTag : roles.filter((r) => forTag.includes(r));
  }
  return [...(roles ?? [])];
}

/**
 * Refuse unless the acting user (the signed-in user, or the API key's
 * creator) holds an org role the workspace names for every consequence tag; returns the role that satisfied the gate, the
 * `role_at_grant` a grant records.
 */
export async function assertConsequenceRole(
  ctx: MandateRoleActor,
  tags: readonly string[],
  overrides: ConsequenceRoles,
  transaction?: Tx,
): Promise<string> {
  const roles = rolesForAllTags(tags, overrides);
  if (roles.length === 0) {
    throw new HandlerError({
      code: "forbidden",
      reason: "no_role_covers_all_tags",
      message: `No single org role is accountable for ${tags.join(", ")} together`,
    });
  }
  return assertOrgRole(
    { ...ctx, userId: await resolveActingUserId(ctx) },
    { org: roles },
    transaction,
  );
}

const USER_PREFIX = "user:";
const ROLE_PREFIX = "role:";

/**
 * Refuse unless the acting user is one of a mandate's `approvers`: a
 * `user:<usr_…>` entry naming their public id, or a `role:<name>` entry
 * naming an org role they hold. An empty list adds no requirement.
 */
export async function assertApprover(
  ctx: MandateRoleActor,
  approvers: readonly string[],
): Promise<void> {
  if (approvers.length === 0) return;
  const refused = () =>
    new HandlerError({
      code: "forbidden",
      reason: "not_an_approver",
      message: `The mandate's approval rule names who may answer: ${approvers.join(", ")}`,
    });
  const userId = await resolveActingUserId(ctx);
  if (!userId) throw refused();

  const users = approvers
    .filter((a) => a.startsWith(USER_PREFIX))
    .map((a) => a.slice(USER_PREFIX.length));
  if (users.length > 0) {
    const [row] = await withTenantDb((tx) =>
      tx
        .select({ publicId: schema.users.publicId })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1),
    );
    if (row && users.includes(row.publicId)) return;
  }

  const roles = approvers
    .filter((a) => a.startsWith(ROLE_PREFIX))
    .map((a) => a.slice(ROLE_PREFIX.length));
  if (roles.length > 0) {
    try {
      await assertOrgRole({ ...ctx, userId }, { org: roles });
      return;
    } catch (err) {
      if (!isHandlerError(err) || err.code !== "forbidden") throw err;
    }
  }
  throw refused();
}
