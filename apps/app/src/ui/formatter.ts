// The app's one date formatter: next-intl's, in the viewer's time zone.
//
// A client component takes its zone from the nearest provider, and the shell
// puts the viewer's there (features/shell/time-zone-provider.tsx). A server
// component does not: next-intl formats it with the request config, which is
// read while the static shell prerenders and so carries only the default. So
// <ViewerClock> writes the viewer's zone into a per-request slot before it
// renders the page, and this hook formats in that zone when the slot is set.
// A page's server components render after the clock returns them as its
// children, so the slot is written by the time they read it.
//
// On the client `cache` does not memoize, so the slot is always empty there
// and next-intl's own formatter, under the provider's zone, is returned.
import { createFormatter, useFormatter as next, useLocale } from "next-intl";
import { cache } from "react";

const slot = cache((): { zone: string | undefined } => ({ zone: undefined }));

/** Called by <ViewerClock> once per request, before the page renders. */
export function setViewerTimeZone(zone: string): void {
  slot().zone = zone;
}

/** next-intl's formatter; on the server, its dates read in the viewer's zone. */
export function useFormatter(): ReturnType<typeof next> {
  const format = next();
  const locale = useLocale();
  const zone = slot().zone;
  return zone === undefined
    ? format
    : createFormatter({ locale, timeZone: zone });
}
