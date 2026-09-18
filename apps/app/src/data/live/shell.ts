// The shell port on the kernel (ARCHITECTURE.md §3.3): the organizations the
// viewer belongs to (list_orgs), the current organization's workspaces
// (list_workspaces), and the person's own clock (get_user_preferences).
import "server-only";
import { orgList } from "@oxagen/oxagen/contracts/org.list";
import {
  DEFAULT_TIME_ZONE,
  userPreferencesRead,
} from "@oxagen/oxagen/contracts/user.preferences.read";
import { workspaceList } from "@oxagen/oxagen/contracts/workspace.list";
import { captureError } from "@oxagen/telemetry";
import { ShellContext, ViewerPreferences } from "@/data/contracts/shell";
import type { DataSource } from "@/data/ports";
import { readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import { isTimeZone } from "@/shared/time-zone";
import { toOrgChoices, toWorkspaceChoices } from "./mappers/pretenant";

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
  async preferences(ctx) {
    const read = await kernelRead(ctx, {
      contract: userPreferencesRead,
      input: {},
      page: "shell",
    });
    if (!read.ok) return read;
    // The column is free text and the contract's regex admits any zone-shaped
    // name, so a stored value this runtime cannot format in is reported once
    // and read as the default: a RangeError from Intl inside every date on the
    // page is the alternative.
    const stored = read.value.timezone;
    let timeZone = stored;
    if (!isTimeZone(stored)) {
      captureError({
        error: new Error(`unsupported time zone ${JSON.stringify(stored)}`),
        source: "app",
        orgId: ctx.orgId,
        context: "shell.preferences time_zone_unsupported",
      });
      timeZone = DEFAULT_TIME_ZONE;
    }
    return readOk(ViewerPreferences.parse({ timeZone }));
  },
};
