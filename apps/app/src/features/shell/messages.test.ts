// The shell's catalog carries every message id the shell's models can ask for,
// and merges with the shared catalog without a namespace collision.
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json";
import shell from "../../../messages/shell.json";
import { catalogStems, mergeCatalogs } from "@/i18n/catalogs";
import { ORG_NAV, THUMB_SLOTS, WORKSPACE_NAV } from "./nav";

const messages = shell.shell;

/** The Organization pages nav labels but no sidebar item (nav.ts ORG_PAGE_NAV). */
const ORG_PAGE_NAV = ["apiKeys", "roles"] as const;

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
    for (const key of [...WORKSPACE_NAV, ...ORG_NAV, ...ORG_PAGE_NAV])
      expect(messages.nav).toHaveProperty(key);
    expect(messages.nav.agents).toBe("Agent IAM");
    expect(Object.keys(messages.mobileNav.slots)).toEqual([...THUMB_SLOTS]);
  });

  it("carries no Ontology label, and no nav label for a page that does not ship (negative)", () => {
    expect(Object.keys(messages.nav).sort()).toEqual(
      [...WORKSPACE_NAV, ...ORG_NAV, ...ORG_PAGE_NAV].sort(),
    );
    expect(JSON.stringify(shell)).not.toMatch(/ontology/i);
  });

  it("carries no catalog for the chrome rev1 does not render", () => {
    // Notifications, the assistant, nav counts and the command menu's runs,
    // actions and questions (ARCHITECTURE.md §1.2). The Account dialog is no
    // longer on that list: spec App. F folds the four account pages into it,
    // and it renders and saves through update_profile.
    expect(Object.keys(messages).sort()).toEqual([
      "account",
      "commands",
      "drawer",
      "loading",
      "mobileNav",
      "nav",
      "sidebar",
      "skipToContent",
      "switcher",
      "topbar",
      "userMenu",
    ]);
    expect(Object.keys(messages.commands).sort()).toEqual([
      "empty",
      "footer",
      "input",
      "title",
    ]);
    expect(Object.keys(messages.sidebar)).not.toContain("countLabel");
    expect(Object.keys(messages.userMenu).sort()).toEqual([
      "account",
      "switchTheme",
      "themeNow",
    ]);
  });
});
