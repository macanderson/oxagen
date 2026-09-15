// The shell port on the kernel (ARCHITECTURE.md §3.3): the organizations the
// viewer belongs to (list_orgs) and the current organization's workspaces
// (list_workspaces), both noBillingGate reads.
import "server-only";
import { orgList } from "@oxagen/oxagen/contracts/org.list";
import { workspaceList } from "@oxagen/oxagen/contracts/workspace.list";
import { captureError } from "@oxagen/telemetry";
import { ShellContext } from "@/data/contracts/shell";
import type { DataSource } from "@/data/ports";
import { readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import { toOrgChoices, toWorkspaceChoices } from "./mappers/shell";

export const shell: DataSource["shell"] = {
  async context(ctx) {
    const [orgs, workspaces] = await Promise.all([
      kernelRead(ctx, { contract: orgList, input: {}, page: "shell" }),
      kernelRead(ctx, {
        contract: workspaceList,
        input: { orgSlug: ctx.orgSlug },
        page: "shell",
      }),
    ]);
    if (!orgs.ok) return orgs;
    if (!workspaces.ok) return workspaces;
    const view = ShellContext.safeParse({
      orgs: toOrgChoices(orgs.value),
      workspaces: toWorkspaceChoices(workspaces.value),
    });
    if (!view.success) {
      captureError({
        error: view.error,
        source: "app",
        orgId: ctx.orgId,
        context: "shell.context record_unmappable",
      });
      return readError("record_unmappable", 502);
    }
    return readOk(view.data);
  },
};
