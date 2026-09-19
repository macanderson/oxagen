"use client";
// The one place a zone enters next-intl below the root layout. A client
// provider on purpose: rendered from a server component,
// `NextIntlClientProvider` fills every prop it is not given from the request
// config, which would ship the whole message catalog to the browser once more
// for each nested provider. Rendered here, it sets the zone and the locale it
// already has, and use-intl's provider inherits messages, formats and `now`
// from the provider above it.
import { NextIntlClientProvider, useLocale } from "next-intl";
import type { ReactNode } from "react";

export function TimeZoneProvider({
  timeZone,
  children,
}: {
  timeZone: string;
  children: ReactNode;
}) {
  const locale = useLocale();
  return (
    <NextIntlClientProvider locale={locale} timeZone={timeZone}>
      {children}
    </NextIntlClientProvider>
  );
}
