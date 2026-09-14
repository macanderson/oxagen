import { describe, expect, it } from "vitest";
import { initials } from "./format";
import { activeWorkspace } from "./shell-data";
import { isCommandShortcut } from "./shell-state";
import { filterByName } from "./switcher-filter";
import { readError, readOk } from "@/data/not-backed";

describe("initials", () => {
  it("takes the first and last word", () => {
    expect(initials("Marcus Bell")).toBe("MB");
    expect(initials("  priya   q natarajan ")).toBe("PN");
    expect(initials("Dana")).toBe("D");
    expect(initials("")).toBe("");
  });
});

describe("activeWorkspace", () => {
  const context = readOk({
    viewer: { id: "u", name: "U", email: "u@x.example" },
    org: {
      slug: "acme",
      name: "Acme",
      plan: null,
      dataPlane: "shared" as const,
      region: null,
    },
    orgs: [{ slug: "acme", name: "Acme", plan: null }],
    workspaces: [
      {
        slug: "core-platform",
        name: "Core",
        mainRepo: null,
        productionBranch: null,
        agentCount: null,
      },
      {
        slug: "finops",
        name: "FinOps",
        mainRepo: null,
        productionBranch: null,
        agentCount: null,
      },
    ],
  });

  it("uses the URL's workspace when it belongs to the organization", () => {
    expect(activeWorkspace({ context }, "finops")).toBe("finops");
  });

  it("falls back to the first workspace for an organization page or an unknown slug", () => {
    expect(activeWorkspace({ context }, null)).toBe("core-platform");
    expect(activeWorkspace({ context }, "nope")).toBe("core-platform");
  });

  it("trusts the URL when the context read failed, and has none without either", () => {
    expect(activeWorkspace({ context: readError("x", 501) }, "finops")).toBe(
      "finops",
    );
    expect(activeWorkspace({ context: readError("x", 501) }, null)).toBeNull();
    const empty = readOk({
      ...(context.ok ? context.value : ({} as never)),
      workspaces: [],
    });
    expect(activeWorkspace({ context: empty }, null)).toBeNull();
  });
});

describe("shell state helpers", () => {
  it("recognises ⌘K and Ctrl+K only", () => {
    const key = (over: Partial<KeyboardEvent>) => ({
      key: "k",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...over,
    });
    expect(isCommandShortcut(key({ metaKey: true }))).toBe(true);
    expect(isCommandShortcut(key({ ctrlKey: true, key: "K" }))).toBe(true);
    expect(isCommandShortcut(key({}))).toBe(false);
    expect(isCommandShortcut(key({ metaKey: true, shiftKey: true }))).toBe(
      false,
    );
    expect(isCommandShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isCommandShortcut(key({ metaKey: true, key: "j" }))).toBe(false);
  });
});

describe("filterByName", () => {
  const orgs = [
    { slug: "acme", name: "Acme Robotics" },
    { slug: "globex", name: "Globex" },
  ];
  it("matches name or slug, case-insensitively", () => {
    expect(filterByName(orgs, "ROBO")).toEqual([orgs[0]]);
    expect(filterByName(orgs, "glob")).toEqual([orgs[1]]);
    expect(filterByName(orgs, " ")).toEqual(orgs);
    expect(filterByName(orgs, "initech")).toEqual([]);
  });
});
