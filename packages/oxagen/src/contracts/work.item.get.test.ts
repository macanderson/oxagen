import { describe, expect, it } from "vitest";
import { workItemGet as contract } from "./work.item.get";

const field = { value: null, by: null, actor: null, at: null };
const OUTPUT = {
  item: {
    id: "wi_01",
    number: "WI-1",
    title: "Fix the invite link",
    origin: "manual",
    source_url: null,
    repository: null,
    requester: null,
    labels: [],
    arrived_at: "2026-10-01T10:00:00.000Z",
    finished_at: null,
    state: "new",
    status: "triaging",
    tab: "inbox",
    version: 1,
    revision: 1,
    priority: { label: null, by: null, reason: null, cites: [], set_by: null },
    wait: { kind: "triaging" },
    send: null,
    cost: { runs: 0, known_runs: 0, total: null },
    description: "The link answers 500.",
    source_revisions: [
      { revision: 1, at: "2026-10-01T10:00:00.000Z", kind: "entered", subject: "Fix the invite link", description: null, labels: [] },
    ],
    collector: null,
  },
  triage: {
    view: {
      decision: null,
      priority: field,
      priority_reason: null,
      cites: [],
      estimate_minutes: field,
      labels: field,
      claims: field,
      criteria: field,
      questions: [],
      duplicates: [],
      related: [],
      conflicts: [],
    },
    standing: { outcome: null, by: null, duplicate_of: null },
    decided_at: null,
    model: null,
    failure: null,
    override: null,
    corrections: [],
  },
  brief: { state: "none", revisions: [], triage_criteria: [], repository: null },
  next_send: null,
  sends: [],
  history: [
    {
      kind: "entered",
      source: "person",
      actor: "Amara",
      at: "2026-10-01T10:00:00.000Z",
      item_revision: 1,
      send: null,
      reason: null,
      resolution: null,
      outcome: null,
      head: null,
      check: null,
      conclusion: null,
      pull_request: null,
      merge_commit: null,
      brief_revision: null,
    },
  ],
  viewer: { can_control: false, can_approve: false },
};

// get_work_item (P1-05, #5163).
describe("get_work_item contract", () => {
  it("registers a read on the API surface that never meters", () => {
    expect(contract.name).toBe("get_work_item");
    expect(contract.surfaces).toEqual(["api"]);
    expect(contract.scoped).toBe(true);
    expect(contract.mutates).toBe(false);
    expect(contract.noBillingGate).toBe(true);
    expect(contract.defaultRoles.workspace.Viewer).toBe("allow");
  });

  it("takes the workspace number or the public id", () => {
    expect(contract.input.parse({ item: "WI-12" })).toEqual({ item: "WI-12" });
    expect(contract.input.parse({ item: " wi_abc " })).toEqual({ item: "wi_abc" });
    expect(contract.input.safeParse({ item: "" }).success).toBe(false);
    expect(contract.input.safeParse({ item: "x".repeat(65) }).success).toBe(false);
    expect(contract.input.safeParse({ item: "WI-12", version: 3 }).success).toBe(false);
  });

  it("answers an item that only a person has read so far", () => {
    expect(contract.output.parse(OUTPUT)).toEqual(OUTPUT);
  });

  it("refuses a wait kind, a brief state, or a field the contract does not name", () => {
    expect(contract.output.safeParse({ ...OUTPUT, item: { ...OUTPUT.item, wait: { kind: "verifying" } } }).success).toBe(false);
    expect(contract.output.safeParse({ ...OUTPUT, brief: { ...OUTPUT.brief, state: "pending" } }).success).toBe(false);
    expect(contract.output.safeParse({ ...OUTPUT, verdict: "proven" }).success).toBe(false);
    expect(contract.output.safeParse({ ...OUTPUT, next_send: { send: 0, key: "wi_01:r1:s0" } }).success).toBe(false);
  });
});
