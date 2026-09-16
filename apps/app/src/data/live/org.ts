// The organization port on the kernel (ARCHITECTURE.md §3.3): the members and
// pending invitations of the viewer's organization, list_members {scope:"org"},
// the workspaces of it the viewer may enter, list_workspaces, and the keys one
// of those workspaces holds, list_api_keys. All three are noBillingGate reads,
// and the members and keys reads are refused by their handler for anyone below
// org Admin.
//
// `apiKeys` takes a WsCtx. An API key names a workspace (ADR-069):
// `auth.api_keys` is policy class `standard`, so under the org-only sentinel
// the list matches no key that exists and a mint writes one into a workspace
// that does not. The page picks a workspace and resolves into it first.
import "server-only";
import { apiKeyList } from "@oxagen/oxagen/contracts/api.key.list";
import { listMembers } from "@oxagen/oxagen/contracts/workspace.member.list";
import { workspaceList } from "@oxagen/oxagen/contracts/workspace.list";
import { captureError } from "@oxagen/telemetry";
import { ApiKeyList, MemberList } from "@/data/contracts/org";
import { WorkspaceChoice } from "@/data/contracts/shell";
import type { DataSource } from "@/data/ports";
import { readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import { toApiKeys, toMemberList } from "./mappers/org";
import { toWorkspaceChoices } from "./mappers/pretenant";

/** A record the view model refuses is reported once and read as unmappable (§3.4). */
function unmappable(ctx: { orgId: string }, context: string, error: unknown) {
  captureError({ error, source: "app", orgId: ctx.orgId, context });
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
    const view =
      read.value.scope === "org"
        ? MemberList.safeParse(toMemberList(read.value))
        : null;
    if (view?.success) return readOk(view.data);
    return unmappable(
      ctx,
      "org.members record_unmappable",
      view?.error ?? new Error("list_members answered workspace scope"),
    );
  },

  async workspaces(ctx) {
    const read = await kernelRead(ctx, {
      contract: workspaceList,
      input: { orgSlug: ctx.orgSlug },
      page: "organization",
    });
    if (!read.ok) return read;
    const view = WorkspaceChoice.array().safeParse(
      toWorkspaceChoices(read.value),
    );
    if (view.success) return readOk(view.data);
    return unmappable(ctx, "org.workspaces record_unmappable", view.error);
  },

  async apiKeys(ctx) {
    const read = await kernelRead(ctx, {
      contract: apiKeyList,
      input: {},
      page: "organization",
    });
    if (!read.ok) return read;
    const view = ApiKeyList.safeParse(toApiKeys(read.value));
    if (view.success) return readOk(view.data);
    return unmappable(ctx, "org.apiKeys record_unmappable", view.error);
  },
};
