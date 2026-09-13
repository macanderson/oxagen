// Test support for the sign-in and onboarding components: the real catalogs,
// a client provider, and a server `getTranslations` stand-in that formats ICU
// arguments the simple way (the components under test use no plurals).
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import auth from "../../../messages/auth.json";
import en from "../../../messages/en.json";
import onboarding from "../../../messages/onboarding.json";

export const messages = { ...en, ...auth, ...onboarding };

export function IntlProvider({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {children}
    </NextIntlClientProvider>
  );
}

function lookup(path: string[]): string {
  let node: unknown = messages;
  for (const part of path) node = (node as Record<string, unknown>)[part];
  if (typeof node !== "string")
    throw new Error(`missing message ${path.join(".")}`);
  return node;
}

/** A synchronous translator over the real catalogs, for mocking `next-intl/server`. */
export function translator(namespace?: string) {
  return (key: string, values: Record<string, string | number> = {}) =>
    lookup([...(namespace ? namespace.split(".") : []), ...key.split(".")])
      .replace(/'\{\}'/g, "{}")
      .replace(/\{(\w+)\}/g, (_m, name: string) => String(values[name]));
}
