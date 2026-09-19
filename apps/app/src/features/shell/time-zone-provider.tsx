"use client";
// The one place a zone enters next-intl below the root layout. A client
// provider on purpose: rendered from a server component,
// `NextIntlClientProvider` fills every prop it is not given from the request
// config, which would ship the whole message catalog to the browser once more
// for each nested provider. Rendered here, it sets the zone and the locale it
// already has, and use-intl's provider inherits messages, formats and `now`
// from the provider above it.
//
// Server Components do not see this provider: they format through the request
// config, which reads the `tz` cookie. Writing that cookie here keeps the next
// request's server dates aligned with the preference the shell just loaded.
import { NextIntlClientProvider, useLocale } from "next-intl";
import { useEffect, type ReactNode } from "react";
import { timeZoneCookieString } from "@/shared/time-zone-cookie";

export function TimeZoneProvider({
  timeZone,
  children,
}: {
  timeZone: string;
  children: ReactNode;
}) {
  const locale = useLocale();
  useEffect(() => {
    document.cookie = timeZoneCookieString(
      timeZone,
      document.URL.startsWith("https:"),
    );
  }, [timeZone]);
  return (
    <NextIntlClientProvider locale={locale} timeZone={timeZone}>
      {children}
    </NextIntlClientProvider>
  );
}
