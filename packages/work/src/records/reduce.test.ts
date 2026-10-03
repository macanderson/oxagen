// reduce.test.ts: a work item's state is a pure function of its facts.
//
// The lifecycle cases walk one item from intake to done, and each failure the
// phase spec names. The order cases prove the reduction does not depend on
// arrival: every permutation of a fixed fact set, and seeded shuffles of a
// longer history, reduce to the same projection. The shuffle uses a fixed
// seed, never Math.random or the clock, so a failure always reproduces.
import { describe, expect, it } from "vitest";
import { type WorkFact, newFact } from "./facts";
import { type WorkItemProjection, reduceWorkItem, reviewGate } from "./reduce";
import { IN_REVIEW, MERGE, READY, SHA1, SHA2, at, digest, f } from "./test-fixtures";

function state(facts: WorkFact[]): WorkItemProjection["state"] {
  return reduceWorkItem(facts).state;
}

describe("reduceWorkItem: intake and triage", () => {
  it("reads an item with no facts as new at revision 1", () => {
    const item = reduceWorkItem([]);
    expect(item).toMatchObject({ state: "new", revision: 1, revisionCause: null, source: null, activeOrder: null, nextSend: 1 });
  });

  it("follows triage's outcome", () => {
    expect(state([f.collected()])).toBe("new");
    expect(reduceWorkItem([f.collected()]).source).toEqual({ revision: 1, digest: digest(101), at: at(0) });
    expect(state([f.collected(), f.triage("triaged")])).toBe("triaged");
    expect(state([f.collected(), f.triage("needs_info")])).toBe("needs_info");
    expect(state([f.collected(), f.triage("duplicate")])).toBe("held");
    expect(state([f.collected(), f.triage("out_of_scope")])).toBe("held");
    expect(reduceWorkItem([f.collected(), f.triage("duplicate")]).triage).toEqual({
      outcome: "duplicate",
      by: "oxagen",
      decision: "tri_1",
      duplicateOf: "wi_other",
    });
  });

  it("keeps an item new and shows the failure when triage output is invalid", () => {
    const item = reduceWorkItem([f.collected(), f.triageFailed()]);
    expect(item.state).toBe("new");
    expect(item.triage).toEqual({ outcome: "failed", by: "oxagen", decision: null, duplicateOf: null });
    expect(state([f.collected(), f.triageFailed(), f.saved(1, 1, 3)])).toBe("triaged");
  });

  it("lets a person's override stand over later triage until the person clears it", () => {
    const overridden = [f.collected(), f.triage("duplicate", 1), f.override("triaged", 2), f.triage("duplicate", 3)];
    expect(state(overridden)).toBe("triaged");
    expect(reduceWorkItem(overridden).triage.by).toBe("person");
    expect(state([...overridden, f.override(null, 4)])).toBe("held");
  });
});

describe("reduceWorkItem: brief and revisions", () => {
  it("is ready once the brief for the current revision is approved", () => {
    const item = reduceWorkItem(READY);
    expect(item.state).toBe("ready");
    expect(item.approvedBrief).toMatchObject({ revision: 1, itemRevision: 1, actor: "marcus", digest: digest(1) });
    expect(item.latestBrief).toMatchObject({ revision: 1, briefId: "brief-1" });
  });

  it("is changed after a material source change, and ready again once revision 2 is approved", () => {
    const changed = [...READY, f.sourceChanged(2, 5)];
    const item = reduceWorkItem(changed);
    expect(item).toMatchObject({ state: "changed", revision: 2, revisionCause: "source", approvedBrief: null });
    expect(item.lastApproval?.itemRevision).toBe(1);
    expect(state([...changed, f.saved(2, 2, 6)])).toBe("changed");
    expect(state([...changed, f.saved(2, 2, 6), f.approved(2, 2, 7)])).toBe("ready");
  });

  it("is changed when a person edits an approved brief", () => {
    const item = reduceWorkItem([...READY, f.saved(2, 2, 5, true)]);
    expect(item).toMatchObject({ state: "changed", revision: 2, revisionCause: "brief" });
  });

  it("treats a source change before any approval as a new revision of the draft", () => {
    expect(state([f.collected(), f.triage("triaged"), f.saved(1, 1, 2), f.sourceChanged(2, 3)])).toBe("triaged");
  });
});

describe("reduceWorkItem: delivery", () => {
  const sent = [...READY, f.send("o1", 1, 1, 1, 4)];

  it("waits for the runtime's claim, then runs, then reviews", () => {
    expect(state(sent)).toBe("sent");
    expect(reduceWorkItem(sent).activeOrder).toMatchObject({ send: 1, delivery: "waiting_for_claim", released: false, closed: false });
    expect(state([...sent, f.runtime("claimed", "o1", 5)])).toBe("running");
    expect(state([...sent, f.runtime("claimed", "o1", 5), f.runtime("run_linked", "o1", 6)])).toBe("running");
    const ended = reduceWorkItem([...sent, f.runtime("run_ended", "o1", 9)]);
    expect(ended.state).toBe("review");
    expect(ended.activeOrder).toMatchObject({ delivery: "run_ended", released: true, closed: false });
    expect(ended.nextSend).toBe(2);
  });

  it("returns to ready after a rejection or a withdrawal", () => {
    const rejected = reduceWorkItem([...sent, f.rejected("o1", 5)]);
    expect(rejected.state).toBe("ready");
    expect(rejected.orders[0]).toMatchObject({ delivery: "rejected", closed: true, released: true });
    expect(state([...sent, f.withdrawn("o1", 5)])).toBe("ready");
  });

  it("keeps an ended send ended when a late claim arrives", () => {
    const late = reduceWorkItem([...sent, f.withdrawn("o1", 5), f.runtime("claimed", "o1", 6)]);
    expect(late.state).toBe("ready");
    expect(late.orders[0]).toMatchObject({ delivery: "withdrawn", closed: true });
    expect(reduceWorkItem([...sent, f.rejected("o1", 6), f.runtime("claimed", "o1", 5)]).orders[0]?.delivery).toBe("rejected");
  });

  it("shows stopping until the runtime confirms, then ready or changed", () => {
    const stopping = [...sent, f.runtime("claimed", "o1", 5), f.stopRequested("o1", 6)];
    expect(reduceWorkItem(stopping).activeOrder?.delivery).toBe("stopping");
    expect(state(stopping)).toBe("running");
    expect(state([...stopping, f.runtime("stopped", "o1", 7)])).toBe("ready");
    expect(state([...stopping, f.sourceChanged(2, 6), f.runtime("stopped", "o1", 7)])).toBe("changed");
  });

  it("keeps a running send on its brief when the source changes", () => {
    const item = reduceWorkItem([...sent, f.runtime("claimed", "o1", 5), f.sourceChanged(2, 6)]);
    expect(item).toMatchObject({ state: "running", revision: 2, changedSinceSend: true });
    expect(item.activeOrder?.briefRevision).toBe(1);
  });

  it("ignores a fact for an order with no send request", () => {
    expect(reduceWorkItem([...READY, f.runtime("claimed", "stray", 5)]).orders).toEqual([]);
  });
});

describe("reduceWorkItem: review and finish", () => {
  it("opens the gate on the head once every required check passed", () => {
    const item = reduceWorkItem(IN_REVIEW);
    expect(item.state).toBe("review");
    const order = item.activeOrder!;
    expect(order).toMatchObject({ head: SHA1, pullRequest: { repository: "aintel/platform", number: 612 }, requiredChecks: ["test"], runIds: ["tse_run1"] });
    expect(order.checks).toEqual([{ name: "test", conclusion: "success", required: true }]);
    expect(reviewGate(item, order)).toEqual({ open: true, requiredChecks: ["test"] });
  });

  it("accepts on the head, waits for the merge, and is done once merged", () => {
    const accepted = reduceWorkItem([...IN_REVIEW, f.accepted("o1", SHA1, 1, 12)]);
    expect(accepted.state).toBe("review");
    expect(accepted.activeOrder?.acceptance).toMatchObject({ headSha: SHA1, actor: "marcus", criteria: ["c1"] });
    expect(reviewGate(accepted, accepted.activeOrder!)).toMatchObject({ open: false, block: "already_accepted" });
    const done = reduceWorkItem([...IN_REVIEW, f.accepted("o1", SHA1, 1, 12), f.merged("o1", SHA1, 13)]);
    expect(done.state).toBe("done");
    expect(done.activeOrder).toBeNull();
    expect(done.orders[0]).toMatchObject({ done: true, closed: true, merge: { headSha: SHA1, mergeCommit: MERGE } });
  });

  it("waits for acceptance after a merge seen before review", () => {
    const merged = reduceWorkItem([...IN_REVIEW, f.merged("o1", SHA1, 12)]);
    expect(merged.state).toBe("review");
    expect(merged.activeOrder).toMatchObject({ released: true, closed: false, done: false });
    expect(state([...IN_REVIEW, f.merged("o1", SHA1, 12), f.accepted("o1", SHA1, 1, 13)])).toBe("done");
  });

  it("voids an acceptance when a new head arrives, and keeps the old one visible", () => {
    const item = reduceWorkItem([...IN_REVIEW, f.accepted("o1", SHA1, 1, 12), f.head("o1", SHA2, 13)]);
    const order = item.activeOrder!;
    expect(item.state).toBe("review");
    expect(order.head).toBe(SHA2);
    expect(order.acceptance).toBeNull();
    expect(order.staleAcceptance?.headSha).toBe(SHA1);
    expect(order.requiredChecks).toBeNull();
    expect(order.checks).toEqual([]);
    expect(reviewGate(item, order)).toEqual({ open: false, block: "checks_unknown", detail: SHA2 });
    expect(state([...IN_REVIEW, f.accepted("o1", SHA1, 1, 12), f.head("o1", SHA2, 13), f.merged("o1", SHA2, 14)])).toBe("review");
  });

  it("keeps a late result on the head it named", () => {
    const item = reduceWorkItem([...IN_REVIEW, f.head("o1", SHA2, 12), f.check("o1", SHA1, "test", "failure", 13), f.claim("o1", "c1", SHA1, 14)]);
    const order = item.activeOrder!;
    expect(order.head).toBe(SHA2);
    expect(order.checks).toEqual([]);
    expect(order.claims).toEqual([{ criterionId: "c1", text: "Covered by a test.", headSha: SHA1, current: false }]);
    const older = reduceWorkItem([...IN_REVIEW, f.head("o1", SHA2, 7)]);
    expect(older.activeOrder?.head).toBe(SHA1);
  });

  it("is not done when the pull request closes without merging", () => {
    const item = reduceWorkItem([...IN_REVIEW, f.accepted("o1", SHA1, 1, 12), f.prClosed("o1", 13)]);
    expect(item.state).toBe("review");
    expect(item.activeOrder).toMatchObject({ prClosed: true, done: false });
    const open = reduceWorkItem([...IN_REVIEW, f.prClosed("o1", 13)]);
    expect(reviewGate(open, open.activeOrder!)).toMatchObject({ open: false, block: "pr_closed" });
    expect(state([...IN_REVIEW, f.prClosed("o1", 12), f.merged("o1", SHA1, 13), f.accepted("o1", SHA1, 1, 14)])).toBe("done");
  });

  it("reads the head, a close, and a merge only on the send's current pull request", () => {
    const pr = (number: number, minute: number) =>
      newFact({ kind: "pr_linked", source: "runtime", itemRevision: 1, actor: "tch_runner", occurredAt: at(minute), dedupeKey: `pr:${number}`, orderId: "o1", repository: "aintel/platform", prNumber: number, data: {} });
    const on = (number: number, kind: "pr_closed" | "head_observed" | "merged", minute: number, sha = SHA1) =>
      newFact({
        kind,
        source: "provider",
        itemRevision: 1,
        actor: "github",
        occurredAt: at(minute),
        dedupeKey: `${kind}:${number}:${minute}`,
        orderId: "o1",
        repository: "aintel/platform",
        prNumber: number,
        ...(kind === "pr_closed" ? {} : { headSha: sha }),
        data: kind === "merged" ? { merge_commit: MERGE } : {},
      } as never) as WorkFact;
    const base = [...READY, f.send("o1", 1, 1, 1, 4), f.runtime("claimed", "o1", 5), f.runtime("run_linked", "o1", 6), f.runtime("run_ended", "o1", 7)];
    // The run closes #10 and opens #11: the send reads #11, open, at #11's head.
    const moved = reduceWorkItem([...base, pr(10, 8), on(10, "head_observed", 8, SHA1), on(10, "pr_closed", 9), pr(11, 10), on(11, "head_observed", 10, SHA2)]);
    expect(moved.activeOrder).toMatchObject({ pullRequest: { repository: "aintel/platform", number: 11 }, head: SHA2, prClosed: false, merge: null });
    // A late close or merge of #10 changes nothing on #11.
    const late = reduceWorkItem([...base, pr(10, 8), pr(11, 10), on(11, "head_observed", 10, SHA2), on(10, "pr_closed", 11), on(10, "merged", 12)]);
    expect(late.activeOrder).toMatchObject({ head: SHA2, prClosed: false, merge: null });
  });

  it("lists every claim by criterion, and labels a check optional until the required checks are read", () => {
    const item = reduceWorkItem([
      ...READY,
      f.send("o1", 1, 1, 1, 4),
      f.prLinked("o1", 5),
      f.head("o1", SHA1, 6),
      f.runtime("run_ended", "o1", 7),
      f.check("o1", SHA1, "test", "success", 8),
      f.claim("o1", "c2", SHA1, 9),
      f.claim("o1", "c1", SHA1, 10),
    ]);
    const order = item.activeOrder!;
    expect(order.requiredChecks).toBeNull();
    expect(order.checks).toEqual([{ name: "test", conclusion: "success", required: false }]);
    expect(order.claims.map((claim) => [claim.criterionId, claim.current])).toEqual([
      ["c1", true],
      ["c2", true],
    ]);
    expect(reviewGate(item, order)).toEqual({ open: false, block: "checks_unknown", detail: SHA1 });
  });

  it("moves no state on an agent's claim", () => {
    const withClaim = [...IN_REVIEW, f.claim("o1", "c1", SHA1, 12), f.claim("o1", "c1", null, 13)];
    expect(state(withClaim)).toBe(state(IN_REVIEW));
    expect(reduceWorkItem(withClaim).activeOrder?.claims).toEqual([{ criterionId: "c1", text: "Covered by a test.", headSha: null, current: false }]);
    const sent = [...READY, f.send("o1", 1, 1, 1, 4), f.claim("o1", "c1", SHA1, 5)];
    expect(state(sent)).toBe("sent");
  });

  it("ends a returned send and lets a new send go out", () => {
    const returned = reduceWorkItem([...IN_REVIEW, f.returned("o1", 12)]);
    expect(returned.state).toBe("ready");
    expect(returned.orders[0]).toMatchObject({ delivery: "returned", closed: true, returned: { reason: "The test is missing." } });
    const resent = reduceWorkItem([...IN_REVIEW, f.returned("o1", 12), f.send("o2", 2, 1, 1, 13)]);
    expect(resent).toMatchObject({ state: "sent", nextSend: 3 });
    expect(resent.activeOrder?.send).toBe(2);
  });
});

describe("reviewGate", () => {
  const gate = (facts: WorkFact[]) => {
    const item = reduceWorkItem(facts);
    const order = item.activeOrder ?? item.orders[item.orders.length - 1]!;
    return reviewGate(item, order);
  };

  it.each([
    ["failure", "check_failed"],
    ["cancelled", "check_failed"],
    ["skipped", "check_failed"],
    ["pending", "check_failed"],
  ] as const)("blocks a required check that reported %s", (conclusion, block) => {
    expect(gate([...IN_REVIEW, f.check("o1", SHA1, "test", conclusion, 12)])).toEqual({ open: false, block, detail: `test: ${conclusion}` });
  });

  it("blocks a required check that never reported, and labels optional checks", () => {
    const facts = [...IN_REVIEW, f.required("o1", SHA1, ["test", "e2e"], 12), f.check("o1", SHA1, "lint", "failure", 13)];
    expect(gate(facts)).toEqual({ open: false, block: "check_missing", detail: "e2e" });
    expect(reduceWorkItem(facts).activeOrder?.checks).toContainEqual({ name: "lint", conclusion: "failure", required: false });
  });

  it("opens with no required check, so acceptance rests on the ticks", () => {
    expect(gate([...IN_REVIEW, f.required("o1", SHA1, [], 12)])).toEqual({ open: true, requiredChecks: [] });
  });

  it("blocks before the run ends, without a pull request or head, and on an out-of-date brief", () => {
    const sent = [...READY, f.send("o1", 1, 1, 1, 4), f.runtime("claimed", "o1", 5)];
    expect(gate(sent)).toMatchObject({ block: "run_active", detail: "claimed" });
    expect(gate([...READY, f.send("o1", 1, 1, 1, 4), f.runtime("run_ended", "o1", 5)])).toMatchObject({ block: "no_pull_request" });
    expect(gate([...READY, f.send("o1", 1, 1, 1, 4), f.prLinked("o1", 5), f.runtime("run_ended", "o1", 6)])).toMatchObject({ block: "no_head" });
    expect(gate([...IN_REVIEW, f.sourceChanged(2, 12)])).toMatchObject({ block: "brief_out_of_date" });
    expect(gate([...IN_REVIEW, f.returned("o1", 12)])).toMatchObject({ block: "order_closed" });
  });
});

describe("reduceWorkItem: close and reopen", () => {
  it("closes, and reopens on a new revision with the brief back to a draft", () => {
    const closed = [...READY, f.closed(1, 5)];
    expect(reduceWorkItem(closed)).toMatchObject({ state: "closed", closure: { resolution: "declined", actor: "marcus" } });
    const reopened = reduceWorkItem([...closed, f.reopened(2, 0, 6)]);
    expect(reopened).toMatchObject({ state: "triaged", revision: 2, revisionCause: "reopen", closure: null, approvedBrief: null });
  });

  it("keeps a done send in history after a reopen and needs a fresh delivery", () => {
    const done = [...IN_REVIEW, f.accepted("o1", SHA1, 1, 12), f.merged("o1", SHA1, 13)];
    const reopened = [...done, f.reopened(2, 1, 14)];
    const item = reduceWorkItem(reopened);
    expect(item).toMatchObject({ state: "triaged", revision: 2, reopenedAfterSend: 1, nextSend: 2 });
    expect(item.orders[0]?.done).toBe(true);
    const again = [...reopened, f.saved(2, 2, 15), f.approved(2, 2, 16), f.send("o2", 2, 2, 2, 17)];
    expect(state(again)).toBe("sent");
  });

  it("ends an open send in review when the item closes, and not a send after the reopen", () => {
    const closed = reduceWorkItem([...IN_REVIEW, f.prClosed("o1", 12), f.closed(1, 13)]);
    expect(closed.orders[0]).toMatchObject({ closed: true });
    const later = reduceWorkItem([
      ...IN_REVIEW,
      f.prClosed("o1", 12),
      f.closed(1, 13),
      f.reopened(2, 1, 14),
      f.saved(2, 2, 15),
      f.approved(2, 2, 16),
      f.send("o2", 2, 2, 2, 17),
    ]);
    expect(later.activeOrder).toMatchObject({ send: 2, closed: false });
  });
});

// ---------------------------------------------------------------------------
// Order independence
// ---------------------------------------------------------------------------

function permutations<T>(list: readonly T[]): T[][] {
  if (list.length <= 1) return [[...list]];
  const out: T[][] = [];
  list.forEach((head, index) => {
    for (const rest of permutations([...list.slice(0, index), ...list.slice(index + 1)])) out.push([head, ...rest]);
  });
  return out;
}

/** mulberry32: a small seeded generator, so every shuffle reproduces. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(list: readonly T[], next: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("reduceWorkItem: order independence", () => {
  it("reduces every permutation of a merge seen before review to done", () => {
    const facts = [
      f.send("o1", 1, 1, 1, 4),
      f.runtime("run_ended", "o1", 9),
      f.prLinked("o1", 7),
      f.head("o1", SHA1, 8),
      f.merged("o1", SHA1, 12),
      f.accepted("o1", SHA1, 1, 13),
      f.approved(1, 1, 3),
    ];
    const expected = reduceWorkItem([...READY.slice(0, 3), ...facts]);
    expect(expected.state).toBe("done");
    const all = permutations(facts);
    expect(all).toHaveLength(5040);
    for (const order of all) expect(reduceWorkItem([...READY.slice(0, 3), ...order])).toEqual(expected);
  });

  it("reduces every permutation of a late old head and a new head to the same review", () => {
    const facts = [
      f.head("o1", SHA2, 13),
      f.accepted("o1", SHA1, 1, 12),
      f.check("o1", SHA1, "test", "failure", 14),
      f.required("o1", SHA2, ["test"], 15),
      f.check("o1", SHA2, "test", "success", 16),
      f.claim("o1", "c1", SHA2, 17),
    ];
    const expected = reduceWorkItem([...IN_REVIEW, ...facts]);
    expect(expected.activeOrder).toMatchObject({ head: SHA2, acceptance: null });
    expect(reviewGate(expected, expected.activeOrder!)).toEqual({ open: true, requiredChecks: ["test"] });
    for (const order of permutations(facts)) expect(reduceWorkItem([...IN_REVIEW, ...order])).toEqual(expected);
  });

  it("reduces 500 seeded shuffles of a full history, with a return, a reopen, and a resend, to the same projection", () => {
    const history = [
      ...IN_REVIEW,
      f.claim("o1", "c1", SHA1, 9),
      f.returned("o1", 12),
      f.send("o2", 2, 1, 1, 13),
      f.runtime("claimed", "o2", 14),
      f.head("o2", SHA2, 15, 1),
      f.runtime("run_ended", "o2", 16),
      f.required("o2", SHA2, ["test"], 17),
      f.check("o2", SHA2, "test", "success", 18),
      f.accepted("o2", SHA2, 1, 19),
      f.merged("o2", SHA2, 20),
      f.reopened(2, 2, 21),
      f.sourceChanged(3, 22),
      f.saved(2, 3, 23),
      f.approved(2, 3, 24),
      f.send("o3", 3, 2, 3, 25),
      f.runtime("claimed", "o3", 26, 3),
    ];
    const expected = reduceWorkItem(history);
    expect(expected).toMatchObject({ state: "running", revision: 3, nextSend: 4, reopenedAfterSend: 2 });
    expect(expected.orders.map((order) => [order.send, order.delivery, order.done, order.closed])).toEqual([
      [1, "returned", false, true],
      [2, "run_ended", true, true],
      [3, "claimed", false, false],
    ]);
    const next = seeded(4897);
    for (let run = 0; run < 500; run += 1) expect(reduceWorkItem(shuffled(history, next))).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Reverts (#5244)
// ---------------------------------------------------------------------------

/** GitHub merged pull request #640 in the same repository, which reverts the send's pull request. */
function reverted(order: string, minute: number, number = 640) {
  return newFact({
    kind: "reverted",
    source: "provider",
    itemRevision: 1,
    actor: "github",
    occurredAt: at(minute),
    dedupeKey: `reverted:${order}:aintel/platform#${number}`,
    orderId: order,
    repository: "aintel/platform",
    prNumber: number,
    data: { merge_commit: "4".repeat(40) },
  });
}

describe("reduceWorkItem: a revert of the merged pull request", () => {
  const DONE = [...IN_REVIEW, f.accepted("o1", SHA1, 1, 12), f.merged("o1", SHA1, 13)];

  it("keeps a done item done, and shows the revert on its send", () => {
    const item = reduceWorkItem([...DONE, reverted("o1", 20)]);
    expect(item.state).toBe("done");
    expect(item.orders[0]).toMatchObject({ done: true, closed: true, released: true });
    expect(item.orders[0]?.revert).toEqual({ repository: "aintel/platform", number: 640, mergeCommit: "4".repeat(40), at: at(20) });
    expect(item.orders[0]?.pullRequest).toEqual({ repository: "aintel/platform", number: 612 });
    expect(reduceWorkItem(DONE).orders[0]?.revert).toBeNull();
  });

  it("keeps the first revert, and shows none on a send that never merged", () => {
    const twice = reduceWorkItem([...DONE, reverted("o1", 20), reverted("o1", 25, 641)]);
    expect(twice.orders[0]?.revert).toMatchObject({ number: 640 });
    const open = reduceWorkItem([...IN_REVIEW, reverted("o1", 20)]);
    expect(open.state).toBe("review");
    expect(open.orders[0]?.revert).toBeNull();
  });

  it("lets a person reopen a reverted item, and keeps the revert in its history", () => {
    const item = reduceWorkItem([...DONE, reverted("o1", 20), f.reopened(2, 1, 21)]);
    expect(item).toMatchObject({ state: "triaged", revision: 2, reopenedAfterSend: 1 });
    expect(item.orders[0]?.revert).toMatchObject({ number: 640 });
  });

  it("reduces every arrival order of a revert, an acceptance, and a merge to the same done item", () => {
    const facts = [f.accepted("o1", SHA1, 1, 12), f.merged("o1", SHA1, 13), reverted("o1", 20)];
    const expected = reduceWorkItem([...IN_REVIEW, ...facts]);
    expect(expected.state).toBe("done");
    for (const order of permutations(facts)) expect(reduceWorkItem([...IN_REVIEW, ...order])).toEqual(expected);
  });
});
