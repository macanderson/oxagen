// Every date under the organization layout renders in the person's own zone.
//
// Client components take the zone from <TimeZoneProvider> below. Server
// Components (`useFormatter` / `getFormatter`) take it from the request config
// in `i18n/request.ts`, which reads the `tz` cookie rather than this preference
// load: Cache Components prerenders the static shell without person-specific
// DB data, so the zone cannot live in that config as a store read. The
// provider writes the cookie when the preference lands, and the Account dialog
// writes it on save, so the next request formats on the server in the same
// zone the client already shows.
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
