// Test support for the sign-in, organization-creation, Fleet, Agents, Audit,
// Billing, Create, Organization, Shell, Skills, Steering, Tools and Repositories
// components: the real catalogs, a client provider, and a server
// `getTranslations` stand-in that formats ICU arguments the simple way (the
// components under test use no plurals).
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import agents from "../../messages/agents.json";
import audit from "../../messages/audit.json";
import auth from "../../messages/auth.json";
import billing from "../../messages/billing.json";
import create from "../../messages/create.json";
import createAgent from "../../messages/create-agent.json";
import createRecord from "../../messages/create-record.json";
import en from "../../messages/en.json";
import fleet from "../../messages/fleet.json";
import mandate from "../../messages/mandate.json";
import onboarding from "../../messages/onboarding.json";
import organization from "../../messages/organization.json";
import record from "../../messages/record.json";
import run from "../../messages/run.json";
import runOutcomes from "../../messages/run-outcomes.json";
import shell from "../../messages/shell.json";
import skills from "../../messages/skills.json";
import steering from "../../messages/steering.json";
import tools from "../../messages/tools.json";
import ui from "../../messages/ui.json";
import repositories from "../../messages/repositories.json";

export const messages = {
  ...en,
  ...agents,
  ...audit,
  ...auth,
  ...billing,
  ...create,
  ...createAgent,
  ...createRecord,
  ...fleet,
  ...mandate,
  ...onboarding,
  ...organization,
  ...record,
  ...run,
  ...runOutcomes,
  ...shell,
  ...skills,
  ...steering,
  ...tools,
  ...ui,
  ...repositories,
};

export function IntlProvider({
  children,
  timeZone = "UTC",
}: {
  children: ReactNode;
  /** Override to prove a surface formats in the viewer's zone, not UTC. */
  timeZone?: string;
}) {
  return (
    <NextIntlClientProvider locale="en" messages={messages} timeZone={timeZone}>
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

type RichValue = string | number | ((chunks: ReactNode) => ReactNode);

/** A synchronous translator over the real catalogs, for mocking `next-intl/server`. */
export function translator(namespace?: string) {
  const format = (key: string, values: Record<string, RichValue> = {}) =>
    lookup([...(namespace ? namespace.split(".") : []), ...key.split(".")])
      .replace(/'\{\}'/g, "{}")
      .replace(/\{(\w+)\}/g, (_m, name: string) => String(values[name]));
  const t = (key: string, values: Record<string, string | number> = {}) =>
    format(key, values);
  /** `t.rich`: each `<tag>…</tag>` becomes what the tag's function returns for its text. */
  t.rich = (key: string, values: Record<string, RichValue> = {}): ReactNode[] =>
    format(key, values)
      .split(/(<\w+>[^<]*<\/\w+>)/)
      .filter((part) => part !== "")
      .map((part) => {
        const tagged = /^<(\w+)>([^<]*)<\/\1>$/.exec(part);
        const render = tagged ? values[tagged[1] ?? ""] : undefined;
        return tagged && typeof render === "function"
          ? render(tagged[2] ?? "")
          : part;
      });
  return t;
}
