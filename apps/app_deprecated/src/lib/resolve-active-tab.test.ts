/**
 * resolve-active-tab.test.ts — unit tests for resolveActiveTab.
 */
import { describe, it, expect } from "vitest";
import { resolveActiveTab } from "./resolve-active-tab";

const tabs = [
  { href: "/org/ws/settings" },
  { href: "/org/ws/settings/general" },
  { href: "/org/ws/settings/members" },
];

describe("resolveActiveTab", () => {
  it("returns the exact match", () => {
    expect(resolveActiveTab(tabs, "/org/ws/settings/general")).toBe(
      "/org/ws/settings/general",
    );
  });

  it("returns the longest prefix match", () => {
    // /org/ws/settings/general/advanced starts with /org/ws/settings/general/ (longer than /org/ws/settings/)
    const deepTabs = [
      { href: "/org/ws/settings" },
      { href: "/org/ws/settings/general" },
    ];
    expect(
      resolveActiveTab(deepTabs, "/org/ws/settings/general/advanced"),
    ).toBe("/org/ws/settings/general");
  });

  it("does not match partial segments (no false-positive prefix)", () => {
    // /org/ws/settingsX does NOT start with /org/ws/settings/ so the short-tab should not match
    const result = resolveActiveTab(
      [{ href: "/org/ws/settings" }, { href: "/org/ws/members" }],
      "/org/ws/settingsX",
    );
    // No match → falls back to first tab
    expect(result).toBe("/org/ws/settings");
  });

  it("falls back to first tab href when no match", () => {
    expect(resolveActiveTab(tabs, "/org/ws/unknown-page")).toBe(
      "/org/ws/settings",
    );
  });

  it("returns empty string when tabs array is empty", () => {
    expect(resolveActiveTab([], "/org/ws/settings")).toBe("");
  });

  it("handles exact match at root path", () => {
    expect(resolveActiveTab([{ href: "/" }], "/")).toBe("/");
  });

  it("selects the deepest match among overlapping hrefs", () => {
    const overlapping = [{ href: "/a" }, { href: "/a/b" }, { href: "/a/b/c" }];
    expect(resolveActiveTab(overlapping, "/a/b/c/d")).toBe("/a/b/c");
  });

  it("is stable with single-tab list", () => {
    expect(resolveActiveTab([{ href: "/only" }], "/other")).toBe("/only");
    expect(resolveActiveTab([{ href: "/only" }], "/only")).toBe("/only");
    expect(resolveActiveTab([{ href: "/only" }], "/only/child")).toBe("/only");
  });
});
