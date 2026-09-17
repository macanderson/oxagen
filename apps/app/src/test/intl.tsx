// Test support for the sign-in, organization-creation, Fleet, Agents, Audit,
// Billing, Organization, Shell, Skills, Steering and Tools components: the real catalogs,
// a client provider, and a server `getTranslations` stand-in that formats ICU
// arguments the simple way (the components under test use no plurals).
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import agents from "../../messages/agents.json";
import audit from "../../messages/audit.json";
import auth from "../../messages/auth.json";
import billing from "../../messages/billing.json";
import en from "../../messages/en.json";
import fleet from "../../messages/fleet.json";
import onboarding from "../../messages/onboarding.json";
import organization from "../../messages/organization.json";
import shell from "../../messages/shell.json";
import skills from "../../messages/skills.json";
import steering from "../../messages/steering.json";
import tools from "../../messages/tools.json";
import ui from "../../messages/ui.json";

export const messages = {
  ...en,
  ...agents,
  ...audit,
  ...auth,
  ...billing,
  ...fleet,
  ...onboarding,
  ...organization,
  ...shell,
  ...skills,
  ...steering,
  ...tools,
  ...ui,
};

export function IntlProvider({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {children}
    </NextIntlClientProvider>
  );
}

function lookup(path: string[]): string {
  let node: unknown = messages;
  for (const part of path)
    node =
      typeof node === "object" && node !== null
        ? Reflect.get(node, part)
        : undefined;
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
