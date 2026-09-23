// The catalogue's three shape rules (ADR-063) and the two folds the role
// editor and the roles read use.
import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import "../contracts/index";
import {
  PERMISSION_CATALOG,
  PERMISSION_GROUPS,
  PERMISSION_IDS,
  capabilitiesOf,
  permissionsHeldBy,
} from "./permission-catalog";

describe("the permission catalogue", () => {
  it("names only registered capabilities", () => {
    for (const permission of PERMISSION_CATALOG) {
      for (const capability of permission.capabilities) {
        expect(
          getCapability(capability),
          `${permission.id} names ${capability}`,
        ).toBeDefined();
      }
    }
  });

  it("gives every permission at least one capability and one of the seven groups", () => {
    for (const permission of PERMISSION_CATALOG) {
      expect(permission.capabilities.length).toBeGreaterThan(0);
      expect(PERMISSION_GROUPS).toContain(permission.group);
    }
  });

  it("uses each id once, and PERMISSION_IDS is the same list", () => {
    const ids = PERMISSION_CATALOG.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...PERMISSION_IDS]).toEqual(ids);
  });
});

describe("runtime.read", () => {
  // The Runtimes page's denied state names runtime.read, so an owner must be
  // able to grant it on Roles (roadmap mockups/pages/runtimes.md, Permissions).
  it("is the Runtimes page's read, over list_tacho_hosts alone", () => {
    expect(capabilitiesOf(["runtime.read"])).toEqual(["list_tacho_hosts"]);
    expect(permissionsHeldBy(new Set(["list_tacho_hosts"]))).toEqual([
      "runtime.read",
    ]);
  });
});

describe("capabilitiesOf", () => {
  it("expands permissions to a sorted, deduplicated capability set", () => {
    const out = capabilitiesOf(["run.control", "run.read", "run.control"]);
    expect(out).toEqual([...new Set(out)].sort());
    expect(out).toContain("dispatch_command");
    expect(out).toContain("list_runs");
  });

  it("refuses an id outside the catalogue", () => {
    expect(() => capabilitiesOf(["org.*"])).toThrow(/Unknown permission/);
  });
});

describe("permissionsHeldBy", () => {
  it("reports a permission only when every capability it names is allowed", () => {
    expect(permissionsHeldBy(new Set(["dispatch_command"]))).toEqual([
      "run.control",
    ]);
    expect(permissionsHeldBy(new Set(["list_runs"]))).toEqual([]);
  });
});
