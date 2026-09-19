// Every date under the organization layout renders in the person's own zone.
//
// The app formats dates in one way, next-intl's `useFormatter().dateTime`, and
// next-intl takes its zone from the nearest provider. The root layout's
// provider inherits the request config, which names no zone because the config
// is read while the static shell prerenders (Cache Components) and a person's
// preference is request data. So the zone is read here, inside the <Suspense>
// the organization layout gives its pages, and <TimeZoneProvider> hands it
// down; locale and messages are inherited from the root provider.
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
  return <TimeZoneProvider timeZone={timeZone}>{children}</TimeZoneProvider>;
}
