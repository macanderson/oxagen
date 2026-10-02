// One work item's detail, decided from built projections (P1-05, #5163): the
// brief's state, the next send's key, each send's delivery and review
// evidence, triage with its failure and override, and the history. The whole
// answer is parsed with get_work_item's own output schema.
import { describe, expect, it } from "vitest";
import { workItemGet } from "@oxagen/oxagen/contracts/work.item.get";
import type { TriageCorrection } from "@oxagen/work";
import { type WorkBrief, type WorkFact, reduceWorkItem } from "@oxagen/work/records";
import {
  type DetailBrief,
  type DetailInput,
  briefStateOf,
  detailOf,
  earlierChecksOf,
  historyOf,
  nextSendOf,
  sendDetailOf,
  triageOf,
} from "./detail";
import {
  AMARA,
  IN_REVIEW,
  ITEM,
  MARCUS,
  O1,
  READY,
  REPOSITORY,
  SENT,
  SHA1,
  SHA2,
  at,
  decision,
  digest,
  f,
  item,
  lookups,
} from "./facts.test-support";

function brief(revision: number, itemRevision: number, author = AMARA): DetailBrief {
  const body: WorkBrief = {
    schema: "work-brief/v1",
    item: ITEM,
    item_revision: itemRevision,
    repository: REPOSITORY,
    source: { url: null, digest: null },
    criteria: [
      { id: "c1", text: "An expired invite shows the expiry message.", tag: "code", intent: "check", evidence: "invite test", provenance: "source" },
    ],
  };
  return { briefId: `brief-${revision}`, publicId: `brf_${revision}`, revision, itemRevision, digest: digest(revision), brief: body, author };
}

function input(facts: readonly WorkFact[], over: Partial<DetailInput> = {}): DetailInput {
  return {
    ...item(facts),
    description: "The link answers 500.",
    collector: { name: "github", health: "healthy" },
    briefs: [],
    decision: { model: "anthropic/claude-haiku", at: at(1) },
    corrections: [],
    actorNames: new Map([
      ["tch_runner", "laptop-1"],
      ["tse_c1run", "laptop-1"],
    ]),
    ...over,
  };
}

describe("briefStateOf", () => {
  const state = (facts: WorkFact[], criteria: string[] = []) => briefStateOf(reduceWorkItem(facts), criteria);

  it("reads none with no brief and no drafted criteria", () => {
    expect(state([f.collected()])).toBe("none");
  });

  it("reads triage_draft when triage drafted criteria nobody saved", () => {
    expect(state([f.collected(), f.triage("triaged")], ["A criterion."])).toBe("triage_draft");
  });

  it("reads draft for a saved brief with no approval on this revision", () => {
    expect(state([f.collected(), f.triage("triaged"), f.saved(1, 1, 2)])).toBe("draft");
    expect(state([...READY, f.closed(1, 4), f.reopened(2, 0, 5)])).toBe("draft");
  });

  it("reads approved for an approval on the current revision", () => {
    expect(state(READY)).toBe("approved");
  });

  it("reads out_of_date once the item changed after approval", () => {
    expect(state([...READY, f.sourceChanged(2, 5)])).toBe("out_of_date");
  });

  it("reads out_of_date while a send runs on an earlier revision", () => {
    expect(state([...SENT, f.runtime("claimed", O1, 5), f.runtime("run_linked", O1, 6), f.sourceChanged(2, 7)])).toBe("out_of_date");
  });
});

describe("nextSendOf", () => {
  it("fixes the next send's key on a ready item", () => {
    expect(nextSendOf(ITEM, reduceWorkItem(READY))).toEqual({ send: 1, key: "wi_x:r1:s1" });
    expect(nextSendOf(ITEM, reduceWorkItem([...SENT, f.withdrawn(O1, 5)]))).toEqual({ send: 2, key: "wi_x:r1:s2" });
  });

  it("offers none while a send is open, with no approval, or once the item is done", () => {
    expect(nextSendOf(ITEM, reduceWorkItem(SENT))).toBeNull();
    expect(nextSendOf(ITEM, reduceWorkItem([f.collected(), f.triage("triaged")]))).toBeNull();
    expect(nextSendOf(ITEM, reduceWorkItem([...IN_REVIEW, f.accepted(O1, SHA1, 12), f.merged(O1, SHA1, 15)]))).toBeNull();
  });
});

describe("sendDetailOf", () => {
  it("records when the send was delivered, claimed, run, and ended", () => {
    const facts = [...SENT, f.delivered(O1, 4), ...IN_REVIEW.slice(SENT.length)];
    const send = sendDetailOf(item(facts), reduceWorkItem(facts).orders[0]!, lookups());
    expect(send).toMatchObject({
      id: "wo_one",
      ended: false,
      no_answer: false,
      operator: "Marcus",
      host: { name: "laptop-1", last_poll_at: at(30) },
      requested_at: at(4),
      delivered_at: at(4),
      claimed_at: at(5),
      first_run_at: at(6),
      run_ended_at: at(9),
      required_checks: ["test"],
      checks: [{ name: "test", conclusion: "success", required: true }],
      checks_word: "passing",
      earlier_checks: null,
      acceptance: null,
      stale_acceptance: null,
      claims: [],
    });
    expect(send.pull_request).toEqual({
      repository: REPOSITORY,
      number: 612,
      url: `https://github.com/${REPOSITORY}/pull/612`,
      head: SHA1,
      head_at: at(8),
      merged: null,
      closed_at: null,
    });
    expect(send.runs).toEqual([{ id: "tse_c1run", cost: null, basis: null, tier: null }]);
  });

  it("keeps a withdrawal, a stop, and a return with who and why", () => {
    const withdrawn = [...SENT, f.withdrawn(O1, 5)];
    expect(sendDetailOf(item(withdrawn), reduceWorkItem(withdrawn).orders[0]!, lookups()).withdrawn).toEqual({
      reason: "Wrong agent.",
      by: "Marcus",
      at: at(5),
    });
    const stopped = [...SENT, f.runtime("claimed", O1, 5), f.runtime("run_linked", O1, 6), f.stopRequested(O1, 7), f.runtime("stopped", O1, 8)];
    const stop = sendDetailOf(item(stopped), reduceWorkItem(stopped).orders[0]!, lookups());
    expect(stop.stop_requested).toEqual({ reason: "Scope changed.", by: "Marcus", at: at(7) });
    expect(stop.stopped_at).toBe(at(8));
    expect(stop.ended).toBe(true);
    const returned = [...IN_REVIEW, f.returned(O1, 12)];
    expect(sendDetailOf(item(returned), reduceWorkItem(returned).orders[0]!, lookups()).returned).toEqual({
      reason: "The test is missing.",
      by: "Marcus",
      at: at(12),
    });
    const rejected = [...SENT, f.rejected(O1, 5)];
    expect(sendDetailOf(item(rejected), reduceWorkItem(rejected).orders[0]!, lookups()).rejected).toEqual({ reason: "Signed out.", at: at(5) });
  });

  it("prices a run the rollup recorded", () => {
    const send = sendDetailOf(
      item(IN_REVIEW),
      reduceWorkItem(IN_REVIEW).orders[0]!,
      lookups({ runs: new Map([["tse_c1run", { costMicros: 420_000n, currency: "USD", basis: "metered", tier: "gateway" }]]) }),
    );
    expect(send.runs).toEqual([{ id: "tse_c1run", cost: { micros: "420000", currency: "USD" }, basis: "metered", tier: "gateway" }]);
    expect(send.cost).toEqual({ runs: 1, known_runs: 1, total: { micros: "420000", currency: "USD" } });
  });

  it("keeps an acceptance on an earlier head visible, and the earlier head's checks apart", () => {
    const facts = [...IN_REVIEW, f.accepted(O1, SHA1, 12), f.head(O1, SHA2, 20), f.check(O1, SHA2, "test", "pending", 21)];
    const send = sendDetailOf(item(facts), reduceWorkItem(facts).orders[0]!, lookups());
    expect(send.acceptance).toBeNull();
    expect(send.stale_acceptance).toEqual({ head: SHA1, by: "Marcus", at: at(12), criteria: ["c1"], required_checks: ["test"] });
    expect(send.checks).toEqual([{ name: "test", conclusion: "pending", required: false }]);
    expect(send.required_checks).toBeNull();
    expect(send.earlier_checks).toEqual({ head: SHA1, checks: [{ name: "test", conclusion: "success", required: true }] });
    expect(send.pull_request?.head_at).toBe(at(20));
  });

  it("records a merge and a close on the pull request", () => {
    const merged = [...IN_REVIEW, f.merged(O1, SHA1, 12)];
    expect(sendDetailOf(item(merged), reduceWorkItem(merged).orders[0]!, lookups()).pull_request?.merged).toEqual({
      at: at(12),
      merge_commit: "9".repeat(40),
    });
    const closed = [...IN_REVIEW, f.prClosed(O1, 12)];
    expect(sendDetailOf(item(closed), reduceWorkItem(closed).orders[0]!, lookups()).pull_request?.closed_at).toBe(at(12));
  });

  it("reads no earlier checks before a second head", () => {
    expect(earlierChecksOf(reduceWorkItem(IN_REVIEW).orders[0]!, IN_REVIEW)).toBeNull();
    expect(earlierChecksOf(reduceWorkItem(SENT).orders[0]!, SENT)).toBeNull();
  });
});

describe("triageOf", () => {
  it("shows the latest run's failure and a person's override in force", () => {
    const facts = [f.collected(), f.triage("triaged", 1), f.triageFailed(2), f.override("out_of_scope", 3)];
    const triage = triageOf(input(facts), lookups());
    expect(triage.failure).toEqual({ reason: "The output did not parse.", at: at(2) });
    expect(triage.override).toEqual({ outcome: "out_of_scope", reason: "Checked by hand.", by: "Amara", at: at(3) });
    expect(triage.standing).toEqual({ outcome: "out_of_scope", by: "person", duplicate_of: null });
    expect(triage.model).toBe("anthropic/claude-haiku");
    expect(triage.decided_at).toBe(at(1));
  });

  it("drops an override a person cleared, and a failure a later run replaced", () => {
    const facts = [f.collected(), f.triageFailed(1), f.triage("triaged", 2), f.override("out_of_scope", 3), f.override(null, 4)];
    const triage = triageOf(input(facts), lookups());
    expect(triage.failure).toBeNull();
    expect(triage.override).toBeNull();
    expect(triage.standing.outcome).toBe("triaged");
  });

  it("names each correction's author, and the person behind a corrected field, by display name", () => {
    const correction: TriageCorrection = { field: "estimate_minutes", before: 30, after: 90, by: MARCUS, at: at(2) };
    const corrected = item([f.collected(), f.triage("triaged")], { corrections: [correction] });
    const triage = triageOf({ ...input(corrected.facts), triage: corrected.triage, corrections: [correction] }, lookups());
    expect(triage.corrections).toEqual([{ field: "estimate_minutes", before: 30, after: 90, by: "Marcus", at: at(2) }]);
    expect(triage.view.estimate_minutes).toEqual({ value: 90, by: "person", actor: "Marcus", at: at(2) });
    expect(triage.view.priority).toEqual({ value: "P1", by: "oxagen", actor: null, at: null });
  });
});

describe("historyOf", () => {
  it("lists every fact in order with who acted and its details", () => {
    const facts = [...IN_REVIEW, f.closed(1, 20)];
    const history = historyOf(input(facts), lookups());
    expect(history.map((entry) => entry.kind)).toEqual(facts.map((fact) => fact.kind));
    expect(history[0]).toMatchObject({ kind: "collected", source: "provider", actor: null, at: at(0), send: null });
    expect(history.find((entry) => entry.kind === "brief_approved")).toMatchObject({ actor: "Amara", brief_revision: 1 });
    expect(history.find((entry) => entry.kind === "send_requested")).toMatchObject({ actor: "Marcus", send: 1, brief_revision: 1 });
    expect(history.find((entry) => entry.kind === "claimed")).toMatchObject({ source: "runtime", actor: "laptop-1", send: 1 });
    expect(history.find((entry) => entry.kind === "pr_linked")).toMatchObject({ actor: "laptop-1", pull_request: `${REPOSITORY}#612` });
    expect(history.find((entry) => entry.kind === "check_observed")).toMatchObject({ check: "test", conclusion: "success", head: SHA1 });
    expect(history.find((entry) => entry.kind === "closed")).toMatchObject({ resolution: "declined", reason: "Not this quarter.", actor: "Marcus" });
  });
});

describe("detailOf", () => {
  it("answers everything get_work_item promises, in the contract's shape", () => {
    const facts = [...IN_REVIEW, f.accepted(O1, SHA1, 12)];
    const detail = detailOf(input(facts, { briefs: [brief(1, 1)] }), lookups());
    const parsed = workItemGet.output.parse({ ...detail, viewer: { can_control: true, can_approve: true } });
    expect(parsed.item).toMatchObject({
      id: ITEM,
      status: "accepted",
      description: "The link answers 500.",
      collector: { name: "github", health: "healthy" },
      source_revisions: [{ revision: 1, at: at(0), kind: "collected", subject: "Fix invites 1", description: null, labels: ["bug"] }],
    });
    expect(parsed.brief).toEqual({
      state: "approved",
      revisions: [
        {
          id: "brf_1",
          revision: 1,
          item_revision: 1,
          digest: digest(1),
          repository: REPOSITORY,
          author: "Amara",
          saved_at: at(2),
          criteria: [
            {
              criterion: "c1",
              text: "An expired invite shows the expiry message.",
              tag: "code",
              intent: "check",
              evidence: "invite test",
              provenance: "source",
            },
          ],
          approved: { by: "Amara", at: at(3) },
        },
      ],
      triage_criteria: [],
      repository: REPOSITORY,
    });
    expect(parsed.next_send).toBeNull();
    expect(parsed.sends.map((send) => send.id)).toEqual(["wo_one"]);
    expect(parsed.sends[0]?.acceptance?.head).toBe(SHA1);
    expect(parsed.triage.view.criteria.value).toEqual(decision().done_record?.criteria);
  });

  it("answers a new item with triage's draft and no sends", () => {
    const detail = detailOf(input([f.collected(), f.triage("triaged")]), lookups());
    const parsed = workItemGet.output.parse({ ...detail, viewer: { can_control: false, can_approve: false } });
    expect(parsed.brief.state).toBe("triage_draft");
    expect(parsed.brief.triage_criteria).toEqual(["An expired invite shows the expiry message."]);
    expect(parsed.brief.repository).toBe(REPOSITORY);
    expect(parsed.sends).toEqual([]);
    expect(parsed.next_send).toBeNull();
  });

  it("lists sends newest first", () => {
    const facts = [...IN_REVIEW, f.returned(O1, 12), f.send("00000000-0000-4000-8000-0000000000c2", 2, 1, 1, 13)];
    const detail = detailOf(input(facts, { briefs: [brief(1, 1)] }), lookups());
    expect(detail.sends.map((send) => send.send)).toEqual([2, 1]);
  });

  it("names a brief triage wrote with no author", () => {
    const detail = detailOf(input(READY, { briefs: [brief(1, 1, "triage")] }), lookups());
    expect(detail.brief.revisions[0]?.author).toBeNull();
  });
});
