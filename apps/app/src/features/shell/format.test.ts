import { describe, expect, it } from "vitest";
import { engineView } from "./engine";
import { parseShellSwitches } from "./fixture-switches";
import {
  formatTimestamp,
  initials,
  sortNotifications,
  unreadCount,
} from "./format";
import { activeWorkspace } from "./shell-data";
import { isCommandShortcut, parseAccountTab } from "./shell-state";
import { filterByName } from "./switcher-filter";
import { denied, notBacked, readError, readOk } from "@/data/not-backed";

describe("formatTimestamp", () => {
  it("formats in UTC so server and client agree", () => {
    expect(formatTimestamp("2026-09-12T23:44:00Z", "en-US")).toBe(
      "Sep 12, 23:44",
    );
  });
});

describe("notifications helpers", () => {
  const items = [
    { at: "2026-09-12T12:00:00Z", unread: false, id: "a" },
    { at: "2026-09-12T15:00:00Z", unread: false, id: "b" },
    { at: "2026-09-12T15:00:00Z", unread: true, id: "c" },
  ];

  it("counts unread", () => {
    expect(unreadCount(items)).toBe(1);
    expect(unreadCount([])).toBe(0);
  });

  it("sorts newest first, unread first at the same instant, without mutating", () => {
    expect(sortNotifications(items).map((i) => i.id)).toEqual(["c", "b", "a"]);
    expect(items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});

describe("initials", () => {
  it("takes the first and last word", () => {
    expect(initials("Marcus Bell")).toBe("MB");
    expect(initials("  priya   q natarajan ")).toBe("PN");
    expect(initials("Dana")).toBe("D");
    expect(initials("")).toBe("");
  });
});

describe("engineView", () => {
  it("is up only when the engine says so", () => {
    expect(
      engineView(
        readOk({ status: "up", model: "glm-flash", version: "0.31.4" }),
      ),
    ).toEqual({
      state: "up",
      model: "glm-flash",
      version: "0.31.4",
    });
  });

  it("names a down engine's status", () => {
    expect(
      engineView(
        readOk({
          status: "down",
          httpStatus: 503,
          version: "0.31.4",
          lastHealthyAt: null,
        }),
      ),
    ).toEqual({
      state: "down",
      reason: "engine",
      httpStatus: 503,
      version: "0.31.4",
      lastHealthyAt: null,
    });
  });

  it("treats every failed read as down, never as ready", () => {
    expect(
      engineView(readError("shell_assistant_engine_not_wired", 501)),
    ).toEqual({
      state: "down",
      reason: "read",
      code: "shell_assistant_engine_not_wired",
      status: 501,
    });
    expect(engineView(denied("assistant.use"))).toMatchObject({
      state: "down",
      status: 403,
    });
    expect(engineView(notBacked("M1", "G6"))).toMatchObject({
      state: "down",
      code: "not_backed_G6",
    });
  });
});

describe("parseShellSwitches", () => {
  it("reads known values", () => {
    expect(
      parseShellSwitches({ engine: "down", notifications: "empty" }),
    ).toEqual({
      engine: "down",
      notifications: "empty",
    });
    expect(parseShellSwitches({ notifications: "error" }).notifications).toBe(
      "error",
    );
    expect(
      parseShellSwitches({ notifications: "not_backed" }).notifications,
    ).toBe("not_backed");
  });

  it("falls back to the defaults for missing or unknown values", () => {
    expect(parseShellSwitches({})).toEqual({
      engine: "up",
      notifications: "loaded",
    });
    expect(
      parseShellSwitches({ engine: "DOWN", notifications: "denied" }),
    ).toEqual({
      engine: "up",
      notifications: "loaded",
    });
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
  it("parses account tabs, defaulting to profile", () => {
    expect(parseAccountTab("security")).toBe("security");
    expect(parseAccountTab("billing")).toBe("profile");
    expect(parseAccountTab(null)).toBe("profile");
  });

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
