// The catalogue's three shape rules (ADR-063) and the two folds the role
// editor and the roles read use.
import { describe, expect, it } from "vitest";
import { getCapability, listCapabilities } from "../registry";
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
  it("is the Runtimes page's read, over the hosts and the runtimes they bind (ADR-198)", () => {
    expect(capabilitiesOf(["runtime.read"])).toEqual([
      "list_runtimes",
      "list_tacho_hosts",
    ]);
    expect(
      permissionsHeldBy(new Set(["list_tacho_hosts", "list_runtimes"])),
    ).toEqual(["runtime.read"]);
  });
});

describe("pr.merge_without_review", () => {
  // A role an owner ticks it on may merge a steering PR with no approval
  // (ADR-213). It names the one capability and sits with the repository
  // permissions.
  it("grants merge_pr_without_review and nothing else", () => {
    const permission = PERMISSION_CATALOG.find(
      (p) => p.id === "pr.merge_without_review",
    );
    expect(permission?.group).toBe("Repository");
    expect(capabilitiesOf(["pr.merge_without_review"])).toEqual([
      "merge_pr_without_review",
    ]);
    expect(
      permissionsHeldBy(new Set(["merge_pr_without_review"])),
    ).toEqual(["pr.merge_without_review"]);
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

describe("the run and work permissions", () => {
  it("keep run.control and run.approve as they were, so no existing role loses them", () => {
    const capabilities = (id: string) => PERMISSION_CATALOG.find((p) => p.id === id)?.capabilities;
    expect(capabilities("run.control")).toEqual(["dispatch_command"]);
    expect(capabilities("run.approve")).toEqual(["resolve_approval"]);
  });

  it("put the work actions in work.control and work.approve", () => {
    expect(capabilitiesOf(["work.control"])).toEqual(
      ["cancel_work_order", "close_work_item", "reopen_work_item", "return_work_order", "save_work_brief", "send_work_order", "stop_work_order"],
    );
    expect(capabilitiesOf(["work.approve"])).toEqual(["accept_work_order", "approve_work_brief", "refresh_work_order_checks"]);
  });

  it("put the Work reads and intake writes in permissions of their own, leaving run.read as it was", () => {
    expect(capabilitiesOf(["work.read"])).toEqual([
      "get_work_item",
      "get_work_outcomes",
      "get_work_priorities",
      "list_work_collectors",
      "list_work_items",
      "list_work_targets",
    ]);
    expect(capabilitiesOf(["work.intake"])).toEqual([
      "create_work_item",
      "retry_work_triage",
      "revise_work_triage",
      "sync_work_collector",
    ]);
    // A role that held run.read before the Work reads existed still holds it.
    expect(capabilitiesOf(["run.read"]).some((name) => name.includes("work"))).toBe(false);
  });

  it("give set_work_collector a permission of its own, for the roles its contract admits", () => {
    expect(capabilitiesOf(["work.collectors"])).toEqual(["set_work_collector"]);
    // No workspace Member, unlike every work.control action.
    expect(getCapability("set_work_collector")?.defaultRoles.workspace).toEqual({ Owner: "allow" });
    expect(getCapability("sync_work_collector")?.defaultRoles.workspace).toEqual({ Owner: "allow", Member: "allow" });
  });
});

describe("the Work capabilities", () => {
  // The calls the runtime and the agent working a send make. The handler
  // checks the host key or the linked run against the order (ADR-251), so a
  // role grant never decides them.
  const RUNTIME_CALLS = new Set(["claim_work_order", "reject_work_order", "claim_work_criterion"]);
  const work = listCapabilities()
    .filter((c) => c.domain === "work")
    .map((c) => c.name)
    .sort();

  it("are registered", () => {
    expect(work).toEqual(expect.arrayContaining(["list_work_items", "set_work_collector", "claim_work_order", "reject_work_order"]));
  });

  it("are each in exactly one permission, so a custom role can grant them", () => {
    for (const name of work) {
      if (RUNTIME_CALLS.has(name)) continue;
      const holders = PERMISSION_CATALOG.filter((p) => p.capabilities.includes(name)).map((p) => p.id);
      expect(holders, name).toHaveLength(1);
    }
  });

  it("leave the runtime's calls out of every permission", () => {
    for (const name of work.filter((n) => RUNTIME_CALLS.has(n))) {
      expect(PERMISSION_CATALOG.some((p) => p.capabilities.includes(name)), name).toBe(false);
    }
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
