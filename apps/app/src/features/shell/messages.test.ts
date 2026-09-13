// The shell's catalog carries every message id the shell's models can ask for,
// and merges with the shared catalog without a namespace collision.
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json";
import shell from "../../../messages/shell.json";
import { catalogStems, mergeCatalogs } from "@/i18n/catalogs";
import { ACTIONS, ASK_QUESTIONS, COMMAND_GROUPS } from "./commands";
import { NotificationSeverity } from "./contracts";
import { ORG_NAV, WORKSPACE_NAV } from "./nav";
import { ACCOUNT_TABS } from "./shell-state";
import { THEMES } from "./theme";

const messages = shell.shell;

describe("messages/shell.json", () => {
  it("is registered and owns only the shell namespace", () => {
    // messages/ is the catalog list: request.ts merges every stem it holds.
    const listing = readdirSync(path.join(process.cwd(), "messages"));
    expect(catalogStems(listing)).toContain("shell");
    expect(Object.keys(shell)).toEqual(["shell"]);
    expect(() =>
      mergeCatalogs([
        ["en", en],
        ["shell", shell],
      ]),
    ).not.toThrow();
  });

  it("names every nav key", () => {
    for (const key of [
      ...WORKSPACE_NAV,
      ...ORG_NAV,
      "apiKeys",
      "roles",
      "register",
    ])
      expect(messages.nav).toHaveProperty(key);
    expect(messages.nav.agents).toBe("Agent IAM");
  });

  it("labels every command group, action and question", () => {
    for (const g of COMMAND_GROUPS)
      expect(messages.commands.groups).toHaveProperty(g);
    for (const a of ACTIONS)
      expect(messages.commands.actions).toHaveProperty(a);
    for (const q of ASK_QUESTIONS)
      expect(messages.commands.questions).toHaveProperty(q);
  });

  it("labels every account tab and theme", () => {
    for (const tab of ACCOUNT_TABS)
      expect(messages.account.tabs).toHaveProperty(tab);
    for (const theme of THEMES)
      expect(messages.account.preferences.themes).toHaveProperty(theme);
  });

  it("covers every notification severity through the enum the icons key on", () => {
    expect(NotificationSeverity.options).toEqual([
      "success",
      "info",
      "attention",
      "critical",
    ]);
  });
});
