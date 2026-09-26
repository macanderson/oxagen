// list_orgs and list_workspaces outputs to organization and workspace choices
// (ARCHITECTURE.md §3.4), for the pretenant port (the CLI consent picker) and
// the shell port (the switchers), which read the same two contracts. Typed
// from the contracts' `_output`, so a field the contract may omit cannot land
// in a required view field. An empty avatar string is read as none: the column
// is free text, and the view model refuses an empty avatar, so one blank row
// would otherwise fail the whole read and take both switchers down.
import type { orgList } from "@oxagen/oxagen/contracts/org.list";
import type { workspaceList } from "@oxagen/oxagen/contracts/workspace.list";
import type { z } from "zod";
import type { OrgChoice, WorkspaceChoice } from "@/data/contracts/shell";
import type { ContractOutput } from "@/server/kernel";

export function toOrgChoices(
  out: ContractOutput<typeof orgList>,
): z.input<typeof OrgChoice>[] {
  return out.organizations.map((org) => ({
    slug: org.slug,
    name: org.name,
    avatarUrl: org.avatarUrl || null,
  }));
}

/**
 * list_workspaces returns every workspace of the organization, with `role`
 * null where the viewer holds no workspace membership. Viewer resolution
 * answers such a workspace with a 404 (INV-15), so it is not a choice.
 */
export function toWorkspaceChoices(
  out: ContractOutput<typeof workspaceList>,
): z.input<typeof WorkspaceChoice>[] {
  return out.workspaces
    .filter((ws) => ws.role !== null)
    .map((ws) => ({
      slug: ws.slug,
      name: ws.name,
      avatarUrl: ws.avatarUrl || null,
    }));
}
