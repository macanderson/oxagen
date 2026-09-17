// The pretenant port on the kernel (ARCHITECTURE.md §3.3): the organizations a
// signed-in person belongs to (list_orgs) and the workspaces of one of them
// the person is a member of (list_workspaces), read with a PretenantCtx before
// any organization context exists. Both contracts are `scoped: false` and
// noBillingGate. list_workspaces refuses an organization the person is not a
// member of, which the kernel seam answers as `denied`.
import "server-only";
import { orgList } from "@oxagen/oxagen/contracts/org.list";
import { workspaceList } from "@oxagen/oxagen/contracts/workspace.list";
import { captureError } from "@oxagen/telemetry";
import { z } from "zod";
import { OrgChoice, WorkspaceChoice } from "@/data/contracts/shell";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import { toOrgChoices, toWorkspaceChoices } from "./mappers/pretenant";

/** The view model parsed at the boundary; a record it refuses is reported once. */
function view<T>(
  schema: z.ZodType<T>,
  value: unknown,
  context: string,
): Read<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return readOk(parsed.data);
  captureError({
    error: parsed.error,
    source: "app",
    context: `${context} record_unmappable`,
  });
  return readError("record_unmappable", 502);
}

export const pretenant: DataSource["pretenant"] = {
  async orgs(ctx) {
    const read = await kernelRead(ctx, {
      contract: orgList,
      input: {},
      page: "shell",
    });
    if (!read.ok) return read;
    return view(z.array(OrgChoice), toOrgChoices(read.value), "pretenant.orgs");
  },

  async workspaces(ctx, orgSlug) {
    const read = await kernelRead(ctx, {
      contract: workspaceList,
      input: { orgSlug },
      page: "shell",
    });
    if (!read.ok) return read;
    return view(
      z.array(WorkspaceChoice),
      toWorkspaceChoices(read.value),
      "pretenant.workspaces",
    );
  },
};
