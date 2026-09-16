// The organization port on the kernel (ARCHITECTURE.md §3.3): the members and
// pending invitations of the viewer's organization (list_members
// {scope:"org"}), its roles with the permission catalogue (list_iam_roles) and
// its workspaces including the archived ones (list_workspaces), each a
// noBillingGate read made with the organization viewer's context.
import "server-only";
import { iamRoleList } from "@oxagen/oxagen/contracts/iam.role.list";
import { workspaceList } from "@oxagen/oxagen/contracts/workspace.list";
import { listMembers } from "@oxagen/oxagen/contracts/workspace.member.list";
import { captureError } from "@oxagen/telemetry";
import type { z } from "zod";
import { MemberList, RoleCatalog, WorkspaceList } from "@/data/contracts/org";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import { toMemberList, toRoleCatalog, toWorkspaceList } from "./mappers/org";

/** The mapped value parsed at the boundary; a record the view refuses is `record_unmappable`, reported once. */
function view<S extends z.ZodType>(
  orgId: string,
  schema: S,
  mapped: z.input<S>,
  read: string,
): Read<z.output<S>> {
  const parsed = schema.safeParse(mapped);
  if (parsed.success) return readOk(parsed.data);
  captureError({
    error: parsed.error,
    source: "app",
    orgId,
    context: `${read} record_unmappable`,
  });
  return readError("record_unmappable", 502);
}

export const org: DataSource["org"] = {
  async members(ctx) {
    const read = await kernelRead(ctx, {
      contract: listMembers,
      input: { scope: "org" },
      page: "organization",
    });
    if (!read.ok) return read;
    // The contract answers a scope union; only the org branch is a roster.
    if (read.value.scope !== "org") {
      captureError({
        error: new Error("list_members answered workspace scope"),
        source: "app",
        orgId: ctx.orgId,
        context: "org.members record_unmappable",
      });
      return readError("record_unmappable", 502);
    }
    return view(
      ctx.orgId,
      MemberList,
      toMemberList(read.value),
      "org.members",
    );
  },

  async roles(ctx) {
    const read = await kernelRead(ctx, {
      contract: iamRoleList,
      input: { includeGrants: true },
      page: "organization",
    });
    if (!read.ok) return read;
    return view(ctx.orgId, RoleCatalog, toRoleCatalog(read.value), "org.roles");
  },

  async workspaces(ctx) {
    const read = await kernelRead(ctx, {
      contract: workspaceList,
      input: { orgSlug: ctx.orgSlug, includeArchived: true },
      page: "organization",
    });
    if (!read.ok) return read;
    return view(
      ctx.orgId,
      WorkspaceList,
      toWorkspaceList(read.value),
      "org.workspaces",
    );
  },
};
