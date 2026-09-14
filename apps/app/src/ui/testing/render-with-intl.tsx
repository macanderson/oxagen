// Test helper: render a primitive inside the same message catalogs the app
// serves (en + ui), so assertions read the real copy rather than keys.
import { render, type RenderOptions } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement, ReactNode } from "react";
import en from "../../../messages/en.json";
import ui from "../../../messages/ui.json";

export const TEST_MESSAGES = { ...en, ...ui };

export function IntlWrapper({
  children,
  locale = "en",
}: {
  children: ReactNode;
  locale?: string;
}) {
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={TEST_MESSAGES}
      timeZone="UTC"
    >
      {children}
    </NextIntlClientProvider>
  );
}

export function renderWithIntl(
  element: ReactElement,
  { locale = "en", ...options }: RenderOptions & { locale?: string } = {},
) {
  return render(element, {
    wrapper: ({ children }) => (
      <IntlWrapper locale={locale}>{children}</IntlWrapper>
    ),
    ...options,
  });
}
