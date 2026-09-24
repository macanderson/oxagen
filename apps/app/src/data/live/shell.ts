// The shell port on the kernel (ARCHITECTURE.md §3.3): the organizations the
// viewer belongs to (list_orgs), the current organization's workspaces
// (list_workspaces), and the person's own clock (get_user_preferences).
import "server-only";
import { notificationsList } from "@oxagen/oxagen/contracts/notification.list";
import { orgList } from "@oxagen/oxagen/contracts/org.list";
import { shellNavCountsGet } from "@oxagen/oxagen/contracts/shell.nav_counts.get";
import {
  DEFAULT_TIME_ZONE,
  userPreferencesRead,
} from "@oxagen/oxagen/contracts/user.preferences.read";
import { workspaceList } from "@oxagen/oxagen/contracts/workspace.list";
import { captureError } from "@oxagen/telemetry";
import { cache } from "react";
import {
  NavCounts,
  NotificationFeed,
  ShellContext,
  ViewerPreferences,
} from "@/data/contracts/shell";
import type { DataSource } from "@/data/ports";
import { readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import { toOrgChoices, toWorkspaceChoices } from "./mappers/pretenant";
import { toNotificationFeed } from "./mappers/shell";

/** The newest rows the bell lists; the unread count covers the whole feed. */
const FEED_LIMIT = 50;

/**
 * True when `Intl` can format in `name` on this runtime. The column is free
 * text and the contract admits any zone-shaped string, so a stored value can
 * still be one this runtime's ICU data has never heard of, and
 * `Intl.DateTimeFormat` throws a RangeError on it inside every date.
 */
function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

// ShellChrome and ViewerClock read preferences independently. React limits
// this report to one call per viewer, organization, and zone in a render.
const reportUnsupportedTimeZone = cache(
  (orgId: string, _userId: string, zone: string) => {
    captureError({
      error: new Error(`unsupported time zone ${JSON.stringify(zone)}`),
      source: "app",
      orgId,
      context: "shell.preferences time_zone_unsupported",
    });
  },
);

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
      reportUnsupportedTimeZone(ctx.orgId, ctx.userId, stored);
      timeZone = DEFAULT_TIME_ZONE;
    }
    return readOk(ViewerPreferences.parse({ timeZone }));
  },
  async counts(ctx) {
    const read = await kernelRead(ctx, {
      contract: shellNavCountsGet,
      input: {},
      page: "shell",
    });
    if (!read.ok) return read;
    // The contract's three nullable counts are the view model's: a null is a
    // store that does not exist, carried through and never read as zero.
    return readOk(NavCounts.parse(read.value));
  },
  async notifications(ctx) {
    const read = await kernelRead(ctx, {
      contract: notificationsList,
      input: { unreadOnly: false, limit: FEED_LIMIT },
      page: "shell",
    });
    if (!read.ok) return read;
    const view = NotificationFeed.safeParse(toNotificationFeed(read.value));
    if (!view.success) {
      captureError({
        error: view.error,
        source: "app",
        orgId: ctx.orgId,
        context: "shell.notifications record_unmappable",
      });
      return readError("record_unmappable", 502);
    }
    return readOk(view.data);
  },
};
