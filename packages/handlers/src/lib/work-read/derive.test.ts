// The Work list's row fields, decided from built projections (P1-05, #5163):
// every status, every wait kind, every checks word, the send summary, the
// priority a person sees, and cost coverage. Every row is parsed with the
// contract's own schema, so a field the contract does not hold fails here.
import { describe, expect, it } from "vitest";
import { workItemStateSchema } from "@oxagen/oxagen/contracts/work.intake.shared";
import { WORK_ACTION_DELIVERY_STATES } from "@oxagen/oxagen/contracts/work.order.shared";
import {
  WORK_CHECKS_WORDS,
  WORK_ITEM_STATUSES,
  type WorkWaitOutput,
  workCheckConclusionSchema,
  workItemRowSchema,
  workReviewBlockSchema,
  workWaitSchema,
} from "@oxagen/oxagen/contracts/work.read.shared";
import type { TriageCorrection } from "@oxagen/work";
import {
  CHECK_CONCLUSIONS,
  DELIVERY_STATES,
  REVIEW_BLOCKS,
  WORK_ITEM_STATES,
  type WorkFact,
  reduceWorkItem,
} from "@oxagen/work/records";
import { type Lookups, type RunCost, type WorkStatus, checksWordOf, costOf, priorityViewOf, rowOf, tabOf } from "./derive";
import {
  AMARA,
  IN_REVIEW,
  MARCUS,
  O1,
  O2,
  READY,
  REPOSITORY,
  SENT,
  SHA1,
  SHA2,
  at,
  decision,
  f,
  item,
  lookups,
  withCommand,
} from "./facts.test-support";

type TriageInput = Parameters<typeof item>[1];

function row(facts: readonly WorkFact[], options: { triage?: TriageInput; lookups?: Lookups } = {}) {
  return workItemRowSchema.parse(rowOf(item(facts, options.triage), options.lookups ?? lookups()));
}

/** Sent, claimed, run, a pull request with head SHA1, and the run ended: no required checks read yet. */
const RUN_WITH_HEAD: WorkFact[] = [
  ...SENT,
  f.runtime("claimed", O1, 5),
  f.runtime("run_linked", O1, 6),
  f.prLinked(O1, 7),
  f.head(O1, SHA1, 8),
  f.runtime("run_ended", O1, 9),
];

const usd = (micros: bigint | null): RunCost => ({ costMicros: micros, currency: "USD", basis: "metered", tier: "gateway" });

describe("the lists the contracts restate", () => {
  it("hold the same values as @oxagen/work/records", () => {
    expect([...workReviewBlockSchema.options]).toEqual([...REVIEW_BLOCKS]);
    expect([...workCheckConclusionSchema.options]).toEqual([...CHECK_CONCLUSIONS]);
    expect([...WORK_ACTION_DELIVERY_STATES]).toEqual([...DELIVERY_STATES]);
    expect([...workItemStateSchema.options]).toEqual([...WORK_ITEM_STATES]);
  });

  it("never offer the words held or proven as a status", () => {
    expect(WORK_ITEM_STATUSES).not.toContain("held");
    expect(WORK_ITEM_STATUSES).not.toContain("proven");
  });
});

describe("tabOf", () => {
  it.each([
    ["new", "inbox"],
    ["held", "inbox"],
    ["triaged", "inbox"],
    ["needs_info", "inbox"],
    ["changed", "inbox"],
    ["ready", "inbox"],
    ["sent", "running"],
    ["running", "running"],
    ["review", "review"],
    ["done", "done"],
    ["closed", "done"],
  ] as const)("puts a %s item on the %s tab", (state, tab) => {
    expect(tabOf(state)).toBe(tab);
  });
});

interface Case {
  name: string;
  facts: WorkFact[];
  triage?: TriageInput;
  lookups?: Lookups;
  status: WorkStatus;
  wait: WorkWaitOutput;
}

const CASES: Case[] = [
  { name: "a new item triage has not decided", facts: [f.collected()], status: "triaging", wait: { kind: "triaging" } },
  {
    name: "a new item whose triage failed",
    facts: [f.collected(), f.triageFailed(1)],
    status: "triage_failed",
    wait: { kind: "triage_failed", reason: "The output did not parse." },
  },
  {
    name: "an item triage asked a question about",
    facts: [f.collected(), f.triage("needs_info")],
    triage: { decision: decision({ state: "needs_info", done_record: null, questions: ["Which page breaks?", "Since when?"] }) },
    status: "needs_info",
    wait: { kind: "needs_info", question: "Which page breaks?" },
  },
  {
    name: "a possible duplicate of another item",
    facts: [f.collected(), f.triage("duplicate")],
    status: "possible_duplicate",
    wait: { kind: "possible_duplicate", of: { id: "wi_other", number: "WI-3" } },
  },
  {
    name: "an item out of scope",
    facts: [f.collected(), f.triage("out_of_scope")],
    status: "out_of_scope",
    wait: { kind: "out_of_scope" },
  },
  {
    name: "a triaged item with criteria triage drafted",
    facts: [f.collected(), f.triage("triaged")],
    status: "brief_to_approve",
    wait: { kind: "brief_to_approve", from_triage: true, reopened: null },
  },
  {
    name: "a triaged item with no criteria",
    facts: [f.collected(), f.triage("triaged")],
    triage: { decision: decision({ done_record: null }) },
    status: "brief_to_approve",
    wait: { kind: "brief_to_write" },
  },
  {
    name: "a triaged item with a saved brief",
    facts: [f.collected(), f.triage("triaged"), f.saved(1, 1, 2)],
    status: "brief_to_approve",
    wait: { kind: "brief_to_approve", from_triage: false, reopened: null },
  },
  {
    name: "a reopened item",
    facts: [...READY, f.closed(1, 4), f.reopened(2, 0, 5)],
    status: "brief_to_approve",
    wait: { kind: "brief_to_approve", from_triage: false, reopened: { by: "Amara", at: at(5), reason: "The bug came back." } },
  },
  {
    name: "an item whose source changed after approval",
    facts: [...READY, f.sourceChanged(2, 5)],
    status: "changed",
    wait: { kind: "changed", cause: "source", at: at(5), approved_revision: 1 },
  },
  {
    name: "an item whose approved brief a person edited",
    facts: [...READY, f.saved(2, 2, 5, true)],
    status: "changed",
    wait: { kind: "changed", cause: "brief", at: at(5), approved_revision: 1 },
  },
  { name: "a ready item", facts: READY, status: "ready", wait: { kind: "ready", last_send: null } },
  {
    name: "a ready item whose send was withdrawn",
    facts: [...SENT, f.withdrawn(O1, 5)],
    status: "ready",
    wait: { kind: "ready", last_send: { delivery: "withdrawn", at: at(5), reason: "Wrong agent." } },
  },
  {
    name: "a ready item whose send was stopped",
    facts: [...SENT, f.runtime("claimed", O1, 5), f.runtime("run_linked", O1, 6), f.stopRequested(O1, 7), f.runtime("stopped", O1, 8)],
    status: "ready",
    wait: { kind: "ready", last_send: { delivery: "stopped", at: at(8), reason: "Scope changed." } },
  },
  {
    name: "a ready item whose send was returned",
    facts: [...IN_REVIEW, f.returned(O1, 12)],
    status: "ready",
    wait: { kind: "ready", last_send: { delivery: "returned", at: at(12), reason: "The test is missing." } },
  },
  {
    name: "a ready item whose send the host rejected",
    facts: [...SENT, f.rejected(O1, 5)],
    status: "send_rejected",
    wait: { kind: "send_rejected", at: at(5), reason: "Signed out." },
  },
  {
    name: "a send waiting for its claim",
    facts: SENT,
    status: "waiting_for_claim",
    wait: { kind: "waiting_for_claim", runtime: "Laptop", sent_at: at(4), last_poll_at: at(30) },
  },
  {
    name: "a send the host took and did not claim (command sent)",
    facts: SENT,
    lookups: withCommand("sent"),
    status: "no_answer",
    wait: { kind: "no_answer", runtime: "Laptop", last_poll_at: at(30) },
  },
  {
    name: "a send the host took and did not claim (command received)",
    facts: SENT,
    lookups: withCommand("received"),
    status: "no_answer",
    wait: { kind: "no_answer", runtime: "Laptop", last_poll_at: at(30) },
  },
  {
    name: "a send the host took and did not claim (send_delivered)",
    facts: [...SENT, f.delivered(O1, 5)],
    lookups: withCommand(null),
    status: "no_answer",
    wait: { kind: "no_answer", runtime: "Laptop", last_poll_at: at(30) },
  },
  {
    name: "a claimed send",
    facts: [...SENT, f.runtime("claimed", O1, 5)],
    status: "running",
    wait: { kind: "running", changed_since_send: false, changed_at: null, brief_revision: 1 },
  },
  {
    name: "a running send whose source moved on",
    facts: [...SENT, f.runtime("claimed", O1, 5), f.runtime("run_linked", O1, 6), f.sourceChanged(2, 7)],
    status: "running",
    wait: { kind: "running", changed_since_send: true, changed_at: at(7), brief_revision: 1 },
  },
  {
    name: "a send a person asked to stop",
    facts: [...SENT, f.runtime("claimed", O1, 5), f.runtime("run_linked", O1, 6), f.stopRequested(O1, 7)],
    status: "stopping",
    wait: { kind: "stopping", runtime: "Laptop" },
  },
  {
    name: "a send ready for review",
    facts: IN_REVIEW,
    status: "in_review",
    wait: { kind: "ready_for_review", head: SHA1 },
  },
  {
    name: "a send whose base branch requires no check",
    facts: [...RUN_WITH_HEAD, f.required(O1, SHA1, [], 10)],
    status: "in_review",
    wait: { kind: "no_required_checks", head: SHA1 },
  },
  {
    name: "a send with a failing required check",
    facts: [...RUN_WITH_HEAD, f.required(O1, SHA1, ["test"], 10), f.check(O1, SHA1, "test", "failure", 11)],
    status: "in_review",
    wait: { kind: "check_failed", check: "test", conclusion: "failure", head: SHA1 },
  },
  {
    name: "a send with a required check that has not reported",
    facts: [...RUN_WITH_HEAD, f.required(O1, SHA1, ["test", "lint"], 10), f.check(O1, SHA1, "test", "success", 11)],
    status: "in_review",
    wait: { kind: "check_missing", check: "lint", head: SHA1 },
  },
  {
    name: "a send with a required check still running",
    facts: [...RUN_WITH_HEAD, f.required(O1, SHA1, ["test"], 10), f.check(O1, SHA1, "test", "pending", 11)],
    status: "in_review",
    wait: { kind: "checks_running", head: SHA1 },
  },
  {
    name: "a send whose required checks nobody read",
    facts: RUN_WITH_HEAD,
    status: "in_review",
    wait: { kind: "checks_unread", head: SHA1 },
  },
  {
    name: "a send whose acceptance a new head voided",
    facts: [...IN_REVIEW, f.accepted(O1, SHA1, 12), f.head(O1, SHA2, 20)],
    status: "in_review",
    wait: { kind: "new_head", head: SHA2, earlier: SHA1, at: at(20) },
  },
  {
    name: "a send with no pull request",
    facts: [...SENT, f.runtime("claimed", O1, 5), f.runtime("run_linked", O1, 6), f.runtime("run_ended", O1, 7)],
    status: "in_review",
    wait: { kind: "no_pull_request" },
  },
  {
    name: "a pull request Oxagen has not read a head for",
    facts: [...SENT, f.runtime("claimed", O1, 5), f.runtime("run_linked", O1, 6), f.prLinked(O1, 7), f.runtime("run_ended", O1, 8)],
    status: "in_review",
    wait: { kind: "no_head" },
  },
  {
    name: "a pull request closed without merging",
    facts: [...IN_REVIEW, f.prClosed(O1, 12)],
    status: "in_review",
    wait: { kind: "pr_closed", at: at(12) },
  },
  {
    name: "a pull request merged before review",
    facts: [...IN_REVIEW, f.merged(O1, SHA1, 12)],
    status: "in_review",
    wait: { kind: "merged_before_review", at: at(12) },
  },
  {
    name: "a send whose item changed after the run",
    facts: [...IN_REVIEW, f.sourceChanged(2, 12)],
    status: "in_review",
    wait: { kind: "brief_out_of_date" },
  },
  {
    name: "a send a person accepted, waiting for its merge",
    facts: [...IN_REVIEW, f.accepted(O1, SHA1, 12)],
    status: "accepted",
    wait: { kind: "accepted_waiting_merge", by: "Marcus", head: SHA1 },
  },
  {
    name: "a done item",
    facts: [...IN_REVIEW, f.accepted(O1, SHA1, 12), f.merged(O1, SHA1, 15)],
    status: "done",
    wait: { kind: "done", accepted: { by: "Marcus", at: at(12), head: SHA1 }, merged_at: at(15) },
  },
  {
    name: "a closed item",
    facts: [f.collected(), f.triage("triaged"), f.closed(1, 5)],
    status: "closed",
    wait: { kind: "closed", resolution: "declined", by: "Marcus", at: at(5), reason: "Not this quarter." },
  },
];

describe("status and wait", () => {
  it.each(CASES)("$name", (entry) => {
    const out = row(entry.facts, { triage: entry.triage, lookups: entry.lookups });
    expect(out.status).toBe(entry.status);
    expect(out.wait).toEqual(entry.wait);
  });

  it("covers every status the contract names", () => {
    expect(new Set(CASES.map((entry) => entry.status))).toEqual(new Set(WORK_ITEM_STATUSES));
  });

  it("covers every wait kind the contract names", () => {
    const kinds = workWaitSchema.options.map((option) => option.shape.kind.value);
    expect(new Set(CASES.map((entry) => entry.wait.kind))).toEqual(new Set(kinds));
  });

  it("names no item a possible duplicate of when the original is not in this workspace", () => {
    const out = row([f.collected(), f.triage("duplicate")], { lookups: lookups({ items: new Map() }) });
    expect(out.wait).toEqual({ kind: "possible_duplicate", of: null });
  });

  it("asks no question when triage asked none", () => {
    const out = row([f.collected(), f.triage("needs_info")], {
      triage: { decision: decision({ state: "needs_info", done_record: null, questions: [] }) },
    });
    expect(out.wait).toEqual({ kind: "needs_info", question: null });
  });

  it("reads a waiting send whose command is only queued as waiting, not as no answer", () => {
    expect(row(SENT, { lookups: withCommand("queued") }).status).toBe("waiting_for_claim");
    expect(row(SENT, { lookups: withCommand(null) }).status).toBe("waiting_for_claim");
  });
});

describe("the row", () => {
  it("copies the item's columns and puts a ready item in the inbox with no send", () => {
    const out = row(READY);
    expect(out).toMatchObject({
      id: "wi_x",
      number: "WI-7",
      title: "Fix invites",
      origin: "provider",
      repository: REPOSITORY,
      requester: "Dana",
      labels: ["bug"],
      arrived_at: at(0),
      finished_at: null,
      state: "ready",
      tab: "inbox",
      version: 4,
      revision: 1,
      send: null,
      cost: { runs: 0, known_runs: 0, total: null },
    });
  });

  it("summarises a send waiting for its claim", () => {
    const out = row(SENT);
    expect(out.tab).toBe("running");
    expect(out.send).toEqual({
      id: "wo_one",
      send: 1,
      key: "wi_x:r1:s1",
      delivery: "waiting_for_claim",
      no_answer: false,
      agent: { id: "agt_bot1", name: "Bot", harness: "claude-code" },
      runtime: { name: "Laptop", tier: "gateway" },
      requested_at: at(4),
      pull_request: null,
      checks: "no_pull_request",
      gate: { open: false, block: "run_active", detail: "waiting_for_claim" },
      accepted: false,
    });
  });

  it("marks a send no answer once its host took the command", () => {
    expect(row(SENT, { lookups: withCommand("sent") }).send?.no_answer).toBe(true);
  });

  it("names the agent and runtime as unknown when their rows are gone", () => {
    const out = row(SENT, { lookups: lookups({ agents: new Map(), runtimes: new Map() }) });
    expect(out.send?.agent).toEqual({ id: null, name: null, harness: null });
    expect(out.send?.runtime).toEqual({ name: null, tier: "gateway" });
    expect(out.wait).toEqual({ kind: "waiting_for_claim", runtime: null, sent_at: at(4), last_poll_at: at(30) });
  });

  it("opens Accept on a passing head and links the pull request", () => {
    const out = row(IN_REVIEW);
    expect(out.tab).toBe("review");
    expect(out.send).toMatchObject({
      delivery: "run_ended",
      checks: "passing",
      gate: { open: true, block: null, detail: null },
      accepted: false,
      pull_request: { repository: REPOSITORY, number: 612, url: `https://github.com/${REPOSITORY}/pull/612`, head: SHA1 },
    });
  });

  it("closes Accept on a head a person already accepted", () => {
    const out = row([...IN_REVIEW, f.accepted(O1, SHA1, 12)]);
    expect(out.send?.accepted).toBe(true);
    expect(out.send?.gate).toEqual({ open: false, block: "already_accepted", detail: SHA1 });
  });

  it("finishes a done item at the later of its acceptance and its merge", () => {
    expect(row([...IN_REVIEW, f.accepted(O1, SHA1, 12), f.merged(O1, SHA1, 15)]).finished_at).toBe(at(15));
    const acceptedLast = row([...IN_REVIEW, f.merged(O1, SHA1, 12), f.accepted(O1, SHA1, 15)]);
    expect(acceptedLast.state).toBe("done");
    expect(acceptedLast.finished_at).toBe(at(15));
    expect(acceptedLast.tab).toBe("done");
    expect(acceptedLast.send?.gate.block).toBe("order_closed");
  });

  it("finishes a closed item when it closed", () => {
    expect(row([f.collected(), f.closed(1, 5)]).finished_at).toBe(at(5));
  });

  it("shows the latest send since the last reopen, and none from before it", () => {
    const resent = row([...IN_REVIEW, f.returned(O1, 12), f.send(O2, 2, 1, 1, 13), f.runtime("claimed", O2, 14)]);
    expect(resent.send?.id).toBe("wo_two");
    expect(resent.send?.send).toBe(2);
    const reopened = row([...IN_REVIEW, f.accepted(O1, SHA1, 12), f.merged(O1, SHA1, 15), f.reopened(2, 1, 16)]);
    expect(reopened.send).toBeNull();
  });
});

describe("checksWordOf", () => {
  const order = (facts: WorkFact[]) => reduceWorkItem(facts).orders[0]!;

  it("ranks a failure over a missing check over a running one", () => {
    expect(
      checksWordOf(
        order([
          ...RUN_WITH_HEAD,
          f.required(O1, SHA1, ["a", "b", "c"], 10),
          f.check(O1, SHA1, "a", "failure", 11),
          f.check(O1, SHA1, "c", "pending", 12),
        ]),
      ),
    ).toBe("failing");
    expect(
      checksWordOf(order([...RUN_WITH_HEAD, f.required(O1, SHA1, ["b", "c"], 10), f.check(O1, SHA1, "c", "pending", 12)])),
    ).toBe("missing");
    expect(checksWordOf(order([...RUN_WITH_HEAD, f.required(O1, SHA1, ["c"], 10), f.check(O1, SHA1, "c", "pending", 12)]))).toBe(
      "running",
    );
  });

  it("reads a cancelled or skipped required check as failing", () => {
    for (const conclusion of ["cancelled", "skipped", "timed_out"] as const) {
      expect(
        checksWordOf(order([...RUN_WITH_HEAD, f.required(O1, SHA1, ["test"], 10), f.check(O1, SHA1, "test", conclusion, 11)])),
      ).toBe("failing");
    }
  });

  it.each([
    ["passing", IN_REVIEW],
    ["unread", RUN_WITH_HEAD],
    ["none_required", [...RUN_WITH_HEAD, f.required(O1, SHA1, [], 10)]],
    ["no_pull_request", SENT],
    ["pr_closed", [...IN_REVIEW, f.prClosed(O1, 12)]],
  ] as const)("reads %s", (word, facts) => {
    expect(checksWordOf(order([...facts]))).toBe(word);
  });

  it("names every checks word the contract lists in this suite", () => {
    const named = ["passing", "failing", "missing", "running", "unread", "none_required", "no_pull_request", "pr_closed"];
    expect(new Set(named)).toEqual(new Set(WORK_CHECKS_WORDS));
  });
});

describe("costOf", () => {
  it("sums the runs whose cost is known and counts the rest as unknown", () => {
    const runs = new Map([
      ["tse_1", usd(1_500_000n)],
      ["tse_2", usd(null)],
    ]);
    expect(costOf(["tse_1", "tse_2", "tse_1", "tse_3"], runs)).toEqual({
      runs: 3,
      known_runs: 1,
      total: { micros: "1500000", currency: "USD" },
    });
  });

  it("answers no total when no cost is known, never a zero", () => {
    expect(costOf(["tse_2"], new Map([["tse_2", usd(null)]]))).toEqual({ runs: 1, known_runs: 0, total: null });
    expect(costOf([], new Map())).toEqual({ runs: 0, known_runs: 0, total: null });
  });

  it("answers no total when the known costs are in different currencies", () => {
    const runs = new Map<string, RunCost>([
      ["tse_1", usd(1n)],
      ["tse_2", { ...usd(2n), currency: "EUR" }],
    ]);
    expect(costOf(["tse_1", "tse_2"], runs)).toEqual({ runs: 2, known_runs: 2, total: null });
  });

  it("covers every run across the item's sends", () => {
    const facts = [
      ...IN_REVIEW,
      f.returned(O1, 12),
      f.send(O2, 2, 1, 1, 13),
      f.runtime("claimed", O2, 14),
      f.runtime("run_linked", O2, 15),
    ];
    const out = row(facts, { lookups: lookups({ runs: new Map([["tse_c1run", usd(2_500_000n)]]) }) });
    expect(out.cost).toEqual({ runs: 2, known_runs: 1, total: { micros: "2500000", currency: "USD" } });
  });
});

describe("priorityViewOf", () => {
  it("shows triage's priority with its reason and the rules it cites", () => {
    expect(row(READY).priority).toEqual({
      label: "P1",
      by: "oxagen",
      reason: "A paying customer is blocked.",
      cites: ["work.priorities#2"],
      set_by: null,
    });
  });

  it("shows a person's correction with their name and no triage reason", () => {
    const correction: TriageCorrection = { field: "priority", before: "P1", after: "P0", by: MARCUS, at: at(2) };
    expect(row(READY, { triage: { corrections: [correction] } }).priority).toEqual({
      label: "P0",
      by: "person",
      reason: null,
      cites: [],
      set_by: "Marcus",
    });
  });

  it("shows no priority before triage decided", () => {
    expect(priorityViewOf(item([f.collected()], { decision: null }).triage, lookups())).toEqual({
      label: null,
      by: null,
      reason: null,
      cites: [],
      set_by: null,
    });
  });

  it("names a person Oxagen holds no name for as null", () => {
    const correction: TriageCorrection = { field: "priority", before: "P1", after: "P2", by: AMARA, at: at(2) };
    const out = rowOf(item(READY, { corrections: [correction] }), lookups({ names: new Map() }));
    expect(out.priority.set_by).toBeNull();
  });
});
