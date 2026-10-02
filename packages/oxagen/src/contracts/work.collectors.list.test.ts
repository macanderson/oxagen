import { describe, expect, it } from "vitest";
import { workCollectorsList as contract } from "./work.collectors.list";

// list_work_collectors (P1-03, #5103).
describe("list_work_collectors contract", () => {
  const collector = {
    collector_id: "00000000-0000-4000-8000-000000000001",
    name: "github",
    type: "github",
    connection_id: "con_01",
    repos: ["acme/web"],
    health: "failing",
    cursor: "2026-10-02T09:00:00Z",
    last_reconcile: {
      at: "2026-10-02T10:00:00.000Z",
      ok: false,
      pages: 0,
      handled: 0,
      missed: 0,
      error: "GitHub GET /user/repos returned HTTP 401.",
    },
    last_success_at: "2026-10-02T09:15:00.000Z",
    failed_streak: 3,
    next_check_at: null,
    last_event_at: null,
    created_at: "2026-10-01T10:00:00.000Z",
  };

  it("takes no input", () => {
    expect(contract.input.parse({})).toEqual({});
    expect(contract.input.safeParse({ name: "github" }).success).toBe(false);
  });

  it("answers each collector's health, last good read, and failed streak", () => {
    expect(contract.output.safeParse({ collectors: [collector] }).success).toBe(true);
    expect(contract.output.safeParse({ collectors: [{ ...collector, health: "broken" }] }).success).toBe(false);
    expect(contract.output.safeParse({ collectors: [{ ...collector, type: "jira" }] }).success).toBe(false);
  });

  it("reads only, and lets a workspace viewer read", () => {
    expect("mutates" in contract).toBe(false);
    expect(contract.defaultRoles.workspace.Viewer).toBe("allow");
  });
});
