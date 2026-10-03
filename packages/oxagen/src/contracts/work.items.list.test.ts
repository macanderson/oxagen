import { describe, expect, it } from "vitest";
import { WORK_ITEMS_LIST_MAX, workItemsList as contract } from "./work.items.list";

const HEAD = "a".repeat(40);
const ROW = {
  id: "wi_01",
  number: "WI-1",
  title: "Fix the invite link",
  origin: "provider",
  source_url: "https://github.com/acme/web/issues/1",
  repository: "acme/web",
  requester: "Dana",
  labels: ["bug"],
  arrived_at: "2026-10-01T10:00:00.000Z",
  finished_at: null,
  state: "review",
  status: "in_review",
  tab: "review",
  version: 9,
  revision: 1,
  priority: { label: "P1", by: "oxagen", reason: "A customer is blocked.", cites: ["work.priorities#2"], set_by: null },
  wait: { kind: "ready_for_review", head: HEAD },
  send: {
    id: "wo_01",
    send: 1,
    key: "wi_01:r1:s1",
    delivery: "run_ended",
    no_answer: false,
    agent: { id: "agt_01", name: "Bot", harness: "claude-code" },
    runtime: { name: "Laptop", tier: "gateway" },
    requested_at: "2026-10-01T10:04:00.000Z",
    pull_request: { repository: "acme/web", number: 12, url: "https://github.com/acme/web/pull/12", head: HEAD },
    pull_requests: [
      {
        id: "fpr_01",
        provider: "github",
        repository: "acme/web",
        number: 12,
        url: "https://github.com/acme/web/pull/12",
        title: "Fix the invite link",
        state: "open",
        head: HEAD,
        state_seen_at: "2026-10-01T10:08:00.000Z",
      },
    ],
    checks: "passing",
    gate: { open: true, block: null, detail: null },
    accepted: false,
  },
  cost: { runs: 2, known_runs: 1, total: { micros: "1500000", currency: "USD" } },
};
const OUTPUT = { items: [ROW], truncated: false, viewer: { can_control: true, can_approve: false } };

// list_work_items (P1-05, #5163).
describe("list_work_items contract", () => {
  it("registers a read on the API surface that never meters", () => {
    expect(contract.name).toBe("list_work_items");
    expect(contract.surfaces).toEqual(["api"]);
    expect(contract.scoped).toBe(true);
    expect(contract.mutates).toBe(false);
    expect(contract.noBillingGate).toBe(true);
  });

  it("lets a workspace viewer read", () => {
    expect(contract.defaultEffect).toBe("deny");
    expect(contract.defaultRoles.workspace.Viewer).toBe("allow");
    expect(contract.defaultRoles.org).toEqual({ Owner: "allow", Admin: "allow" });
  });

  it("reads up to the most items one read answers", () => {
    expect(contract.input.parse({})).toEqual({ limit: WORK_ITEMS_LIST_MAX });
    expect(contract.input.parse({ limit: 25 })).toEqual({ limit: 25 });
    expect(contract.input.safeParse({ limit: 0 }).success).toBe(false);
    expect(contract.input.safeParse({ limit: WORK_ITEMS_LIST_MAX + 1 }).success).toBe(false);
    expect(contract.input.safeParse({ cursor: "x" }).success).toBe(false);
  });

  it("answers rows with their status, wait, send, and cost", () => {
    expect(contract.output.parse(OUTPUT)).toEqual(OUTPUT);
    expect(contract.output.safeParse({ ...OUTPUT, items: [{ ...ROW, send: null, wait: { kind: "triaging" } }] }).success).toBe(true);
  });

  it("refuses a wait kind, a status, or a field the contract does not name", () => {
    const withRow = (row: Record<string, unknown>) => contract.output.safeParse({ ...OUTPUT, items: [{ ...ROW, ...row }] }).success;
    expect(withRow({ wait: { kind: "verifying" } })).toBe(false);
    expect(withRow({ status: "held" })).toBe(false);
    expect(withRow({ status: "proven" })).toBe(false);
    expect(withRow({ owner: "Dana" })).toBe(false);
    expect(withRow({ cost: { runs: 1, known_runs: 1, total: { micros: "1.5", currency: "USD" } } })).toBe(false);
  });

  it("lists every pull request the send has, a draft and a 64-character head included", () => {
    const [first] = ROW.send.pull_requests;
    const second = { ...first, id: "fpr_02", number: 13, title: null, state: "draft", head: "b".repeat(64) };
    const withPulls = (pulls: unknown[]) =>
      contract.output.safeParse({ ...OUTPUT, items: [{ ...ROW, send: { ...ROW.send, pull_requests: pulls } }] }).success;
    expect(withPulls([second, first])).toBe(true);
    expect(withPulls([])).toBe(true);
    expect(withPulls([{ ...first, state: "closing" }])).toBe(false);
    expect(withPulls([{ ...first, head: "B".repeat(40) }])).toBe(false);
    expect(withPulls([{ ...first, checks: "passing" }])).toBe(false);
    const withoutPulls = Object.fromEntries(Object.entries(ROW.send).filter(([key]) => key !== "pull_requests"));
    expect(contract.output.safeParse({ ...OUTPUT, items: [{ ...ROW, send: withoutPulls }] }).success).toBe(false);
  });
});
