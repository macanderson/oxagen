// list_members — the org's members and pending invitations, or the members of
// the request's workspace. Every query runs in the tenant scope the kernel
// entered from the request context and repeats the org or workspace predicate
// explicitly, so RLS and the WHERE clause both bound the read; nothing in the
// input can widen it.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { listMembers } from "@oxagen/oxagen/contracts/workspace.member.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";

const memberColumns = {
  id: schema.users.publicId,
  name: schema.users.displayName,
  email: schema.users.email,
  avatarUrl: schema.users.avatarUrl,
};

type MemberRow = {
  id: string;
  name: string | null;
  email: string;
  avatarUrl: string | null;
  role: string;
  joinedAt: Date;
};

const toMember = (r: MemberRow) => ({
  id: r.id,
  name: r.name,
  email: r.email,
  // `users.avatar_url` has no CHECK. A blank value would fail the contract's
  // `min(1)` and refuse the whole roster, so it reads as none.
  avatarUrl: r.avatarUrl?.trim() || null,
  role: r.role,
  joinedAt: r.joinedAt.toISOString(),
});

export const listMembersHandler: CapabilityHandler<typeof listMembers> = async (
  input,
  ctx,
) => {
  if (input.scope === "org") {
    const { members, invitations } = await withTenantDb(async (tx) => {
      const ou = schema.orgUsers;
      const inv = schema.invitations;
      const members = await tx
        .select({ ...memberColumns, role: ou.role, joinedAt: ou.joinedAt })
        .from(ou)
        .innerJoin(schema.users, eq(schema.users.id, ou.userId))
        .where(and(eq(ou.orgId, ctx.orgId), isNull(schema.users.deletedAt)))
        .orderBy(asc(ou.joinedAt));
      const invitations = await tx
        .select({
          id: inv.publicId,
          email: inv.email,
          role: inv.role,
          invitedAt: inv.createdAt,
          expiresAt: inv.expiresAt,
        })
        .from(inv)
        .where(and(eq(inv.orgId, ctx.orgId), eq(inv.status, "pending")))
        .orderBy(desc(inv.createdAt));
      return { members, invitations };
    });

    logger.info(
      {
        orgId: ctx.orgId,
        members: members.length,
        invitations: invitations.length,
        surface: ctx.surface,
      },
      "list_members: returned the org roster",
    );

    return {
      scope: "org" as const,
      members: members.map(toMember),
      invitations: invitations.map((r) => ({
        id: r.id,
        email: r.email,
        role: r.role,
        invitedAt: r.invitedAt.toISOString(),
        expiresAt: r.expiresAt?.toISOString() ?? null,
      })),
    };
  }

  const wu = schema.workspaceUsers;
  const members = await withTenantDb((tx) =>
    tx
      .select({ ...memberColumns, role: wu.role, joinedAt: wu.joinedAt })
      .from(wu)
      .innerJoin(schema.users, eq(schema.users.id, wu.userId))
      .where(
        and(
          eq(wu.workspaceId, ctx.workspaceId),
          isNull(schema.users.deletedAt),
        ),
      )
      .orderBy(asc(wu.joinedAt)),
  );

  logger.info(
    {
      workspaceId: ctx.workspaceId,
      members: members.length,
      surface: ctx.surface,
    },
    "list_members: returned the workspace members",
  );

  return { scope: "workspace" as const, members: members.map(toMember) };
};
