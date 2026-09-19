// Every date under the organization layout renders in the person's own zone.
//
// Client components take the zone from <TimeZoneProvider> below. Server
// components cannot: next-intl's request config is read while the static shell
// prerenders, so it carries only Pacific time. This component writes the
// viewer's zone into `@/ui/formatter`'s per-request slot via
// `setViewerTimeZone` before returning children, then wraps them in
// <TimeZoneProvider> for the client tree.
//
// A person's zone is a preference, not a session claim: `get_user_preferences`
// through the shell port, the same read the chrome makes (deduplicated per
// request by the kernel seam). A failed read is not worth a blank page: the
// pages render in the default zone and the seam has already reported the
// failure.
import "server-only";
import { DEFAULT_TIME_ZONE } from "@oxagen/oxagen/contracts/user.preferences.read";
import type { ReactNode } from "react";
import type { DataSource } from "@/data/ports";
import type { OrgCtx } from "@/server/viewer";
import { setViewerTimeZone } from "@/ui/formatter";
import { TimeZoneProvider } from "./time-zone-provider";

export async function ViewerClock({
  ctx,
  source,
  children,
}: {
  ctx: OrgCtx;
  source: Pick<DataSource, "shell">;
  children: ReactNode;
}) {
  const preferences = await source.shell.preferences(ctx);
  const timeZone = preferences.ok
    ? preferences.value.timeZone
    : DEFAULT_TIME_ZONE;
  // Write before returning children so server components under this tree
  // format through `@/ui/formatter` in the same zone the client provider shows.
  setViewerTimeZone(timeZone);
  return <TimeZoneProvider timeZone={timeZone}>{children}</TimeZoneProvider>;
}
