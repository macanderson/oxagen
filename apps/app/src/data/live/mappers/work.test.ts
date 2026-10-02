// The Work mappers over real contract output: each sample is parsed by its
// contract's own output schema first, so it is what the handler can return,
// then mapped and parsed by the view model. A cost the record does not hold
// stays null, a run's unknown basis is null, and every wait kind keeps its
// facts under the view's names.
import { workItemGet } from "@oxagen/oxagen/contracts/work.item.get";
import { workItemsList } from "@oxagen/oxagen/contracts/work.items.list";
import { workOutcomesGet } from "@oxagen/oxagen/contracts/work.outcomes.get";
import { workTargetsList } from "@oxagen/oxagen/contracts/work.targets.list";
import { describe, expect, it } from "vitest";
import {
  WorkItemDetail,
  WorkItemList,
  WorkOutcomes,
  WorkTargetList,
} from "@/data/contracts/work";
import { toWorkItemDetail } from "./work-item";
import { toWorkItemList, toWorkOutcomes, toWorkTargetList } from "./work-list";

const HEAD = "3f9a2c1d4e5f60718293a4b5c6d7e8f901234567";
const EARLIER = "2d4f6a80123456789abcdef0123456789abcdef0";
const DIGEST = `sha256:${"a".repeat(64)}`;
const AT = "2026-10-02T12:58:00.000Z";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "wi_01k6review",
    number: "WI-12",
    title: "Return a Retry-After header on 429",
    origin: "provider",
    source_url: "https://github.com/acme/platform/issues/612",
    repository: "acme/platform",
    requester: "octocat",
    labels: ["Bug"],
    arrived_at: AT,
    finished_at: null,
    state: "review",
    status: "in_review",
    tab: "review",
    version: 9,
    revision: 1,
    priority: { label: "P1", by: "oxagen", reason: "A customer-reported defect with no workaround.", cites: ["work.priorities#4"], set_by: null },
    wait: { kind: "check_failed", check: "test", conclusion: "failure", head: HEAD },
    send: {
      id: "wo_01k6send",
      send: 1,
      key: "wi_01k6review:r1:s1",
      delivery: "run_ended",
      no_answer: false,
      agent: { id: "agt_01k6agent", name: "stella-ci", harness: "stella" },
      runtime: { name: "CI runner 6", tier: "gateway" },
      requested_at: AT,
      pull_request: { repository: "acme/platform", number: 612, url: "https://github.com/acme/platform/pull/612", head: HEAD },
      checks: "failing",
      gate: { open: false, block: "check_failed", detail: "test: failure" },
      accepted: false,
    },
    cost: { runs: 2, known_runs: 1, total: { micros: "1250000", currency: "USD" } },
    ...overrides,
  };
}

describe("toWorkItemList", () => {
  const out = workItemsList.output.parse({
    items: [
      row(),
      row({
        id: "wi_01k6triage",
        number: "WI-13",
        state: "new",
        status: "triage_failed",
        tab: "inbox",
        priority: { label: null, by: null, reason: null, cites: [], set_by: null },
        wait: { kind: "triage_failed", reason: "Triage returned no valid suggestion after 2 tries." },
        send: null,
        cost: { runs: 0, known_runs: 0, total: null },
      }),
    ],
    truncated: false,
    viewer: { can_control: true, can_approve: false },
  });
  const view = WorkItemList.parse(toWorkItemList(out));

  it("renames every row field and keeps the server's status, tab, and wait", () => {
    const [first] = view.items;
    expect(first).toMatchObject({
      id: "wi_01k6review",
      number: "WI-12",
      sourceUrl: "https://github.com/acme/platform/issues/612",
      status: "in_review",
      tab: "review",
      wait: { kind: "check_failed", check: "test", conclusion: "failure", head: HEAD },
      send: { noAnswer: false, checks: "failing", gate: { open: false, block: "check_failed" } },
      cost: { runs: 2, knownRuns: 1, total: { micros: "1250000", currency: "USD" } },
    });
    expect(view.viewer).toEqual({ canControl: true, canApprove: false });
  });

  it("keeps an unknown cost null and invents no zero", () => {
    const second = view.items[1];
    expect(second?.cost).toEqual({ runs: 0, knownRuns: 0, total: null });
    expect(second?.priority.label).toBeNull();
    expect(second?.wait).toEqual({ kind: "triage_failed", reason: "Triage returned no valid suggestion after 2 tries." });
  });
});

describe("toWorkItemDetail", () => {
  const out = workItemGet.output.parse({
    item: {
      ...row({
        wait: { kind: "new_head", head: HEAD, earlier: EARLIER, at: AT },
      }),
      description: "<script>alert(1)</script> The 429 has no Retry-After.",
      source_revisions: [
        { revision: 1, at: AT, kind: "collected", subject: "Return a Retry-After header on 429", description: null, labels: ["Bug"] },
      ],
      collector: { name: "github", health: "failing" },
    },
    triage: {
      view: {
        decision: "tri_01k6",
        priority: { value: "P1", by: "oxagen", actor: null, at: null },
        priority_reason: "A customer-reported defect with no workaround.",
        cites: ["work.priorities#4"],
        estimate_minutes: { value: 45, by: "oxagen", actor: null, at: null },
        labels: { value: ["Bug"], by: "person", actor: "Marcus Bell", at: AT },
        claims: { value: ["src/api/**"], by: "oxagen", actor: null, at: null },
        criteria: { value: ["The 429 carries Retry-After."], by: "oxagen", actor: null, at: null },
        questions: [],
        duplicates: [],
        related: [],
        conflicts: [],
      },
      standing: { outcome: "triaged", by: "oxagen", duplicate_of: null },
      decided_at: AT,
      model: null,
      failure: null,
      override: null,
      corrections: [{ field: "labels", before: ["Feature"], after: ["Bug"], by: "Marcus Bell", at: AT }],
    },
    brief: {
      state: "approved",
      revisions: [
        {
          id: "brf_01k6",
          revision: 1,
          item_revision: 1,
          digest: DIGEST,
          repository: "acme/platform",
          author: "Marcus Bell",
          saved_at: AT,
          criteria: [
            { criterion: "c1", text: "The 429 carries Retry-After.", tag: "code", intent: "check", evidence: "api test", provenance: "triage" },
          ],
          approved: { by: "Marcus Bell", at: AT },
        },
      ],
      triage_criteria: ["The 429 carries Retry-After."],
      repository: "acme/platform",
    },
    next_send: null,
    sends: [
      {
        id: "wo_01k6send",
        send: 1,
        key: "wi_01k6review:r1:s1",
        delivery: "run_ended",
        no_answer: false,
        ended: false,
        item_revision: 1,
        brief_revision: 1,
        brief_digest: DIGEST,
        agent: { id: "agt_01k6agent", name: "stella-ci", harness: "stella" },
        runtime: { name: "CI runner 6", tier: "harness" },
        host: { name: "ci-runner-6", last_poll_at: AT },
        operator: "Marcus Bell",
        mandate_id: "mnd_01k6",
        requested_at: AT,
        delivered_at: AT,
        claimed_at: AT,
        first_run_at: AT,
        run_ended_at: AT,
        rejected: null,
        withdrawn: null,
        stop_requested: null,
        stopped_at: null,
        returned: null,
        runs: [
          { id: "tse_01k6a", cost: { micros: "1250000", currency: "USD" }, basis: "client_attested", tier: "harness" },
          { id: "tse_01k6b", cost: null, basis: null, tier: null },
          { id: "tse_01k6c", cost: { micros: "10", currency: "USD" }, basis: "a basis the view does not know", tier: "harness" },
        ],
        cost: { runs: 3, known_runs: 2, total: { micros: "1250010", currency: "USD" } },
        pull_request: {
          repository: "acme/platform",
          number: 612,
          url: "https://github.com/acme/platform/pull/612",
          head: HEAD,
          head_at: AT,
          merged: null,
          closed_at: null,
        },
        required_checks: ["test"],
        checks: [{ name: "test", conclusion: "pending", required: true }],
        earlier_checks: { head: EARLIER, checks: [{ name: "test", conclusion: "success", required: true }] },
        checks_word: "running",
        gate: { open: false, block: "check_failed", detail: "test: pending" },
        acceptance: null,
        stale_acceptance: { head: EARLIER, by: "Marcus Bell", at: AT, criteria: ["c1"], required_checks: ["test"] },
        claims: [],
      },
    ],
    history: [
      {
        kind: "accepted",
        source: "person",
        actor: "Marcus Bell",
        at: AT,
        item_revision: 1,
        send: 1,
        reason: null,
        resolution: null,
        outcome: null,
        head: EARLIER,
        check: null,
        conclusion: null,
        pull_request: null,
        merge_commit: null,
        brief_revision: null,
      },
    ],
    viewer: { can_control: false, can_approve: false },
  });
  const view = WorkItemDetail.parse(toWorkItemDetail(out));

  it("keeps the source text as the record holds it, for the page to render as text", () => {
    expect(view.item.description).toBe("<script>alert(1)</script> The 429 has no Retry-After.");
    expect(view.item.collector).toEqual({ name: "github", health: "failing" });
    expect(view.item.wait).toEqual({ kind: "new_head", head: HEAD, earlier: EARLIER, at: AT });
  });

  it("maps a run's cost with its basis, keeps an unreported cost null, and drops a basis the view does not know", () => {
    const [send] = view.sends;
    expect(send?.runs).toEqual([
      { id: "tse_01k6a", cost: { micros: "1250000", currency: "USD", basis: "client_attested" }, tier: "harness" },
      { id: "tse_01k6b", cost: null, tier: null },
      { id: "tse_01k6c", cost: { micros: "10", currency: "USD", basis: null }, tier: "harness" },
    ]);
    expect(send?.cost).toEqual({ runs: 3, knownRuns: 2, total: { micros: "1250010", currency: "USD" } });
  });

  it("keeps the stale acceptance and the earlier head's results beside the current head", () => {
    const [send] = view.sends;
    expect(send?.acceptance).toBeNull();
    expect(send?.staleAcceptance).toMatchObject({ head: EARLIER, criteria: ["c1"], requiredChecks: ["test"] });
    expect(send?.earlierChecks).toEqual({ head: EARLIER, checks: [{ name: "test", conclusion: "success", required: true }] });
    expect(send?.checksWord).toBe("running");
  });

  it("keeps each criterion's stable key and the triage corrections", () => {
    expect(view.brief.revisions[0]?.criteria[0]?.criterion).toBe("c1");
    expect(view.triage.corrections).toEqual([{ field: "labels", before: ["Feature"], after: ["Bug"], by: "Marcus Bell", at: AT }]);
    expect(view.triage.model).toBeNull();
    expect(view.viewer).toEqual({ canControl: false, canApprove: false });
  });
});

describe("toWorkTargetList and toWorkOutcomes", () => {
  it("keeps each agent's refusal reason and a quiet host", () => {
    const out = workTargetsList.output.parse({
      agents: [
        {
          id: "agt_01k6agent",
          name: "stella-ci",
          harness: "stella",
          runtime: { id: "rtm_01k6", name: "CI runner 6", tier: "gateway" },
          host: { name: "ci-runner-6", last_poll_at: null, takes_work_orders: false },
          operates: true,
          busy_with: null,
          can_take: false,
          reason: "host_outdated",
          quiet: true,
        },
      ],
    });
    expect(WorkTargetList.parse(toWorkTargetList(out)).agents[0]).toMatchObject({
      canTake: false,
      reason: "host_outdated",
      quiet: true,
      host: { lastPollAt: null, takesWorkOrders: false },
    });
  });

  it("keeps a lead time with no sample null and an unknown cost total null", () => {
    const out = workOutcomesGet.output.parse({
      days: 30,
      since: AT,
      accepted_merged: 0,
      returned: 1,
      closed: { cancelled: 0, declined: 1, duplicate: 2 },
      lead_time: { median_hours: null, p90_hours: null, sample: 0 },
      touches: { per_item: null, brief_approvals: 0, acceptances: 0, returns: 1, triage_overrides: 0, triage_corrections: 0 },
      cost: { runs: 1, known_runs: 0, total: null },
      reopens: { cohort: 0, reopened: 0, waiting: 0 },
      delivery: {
        sends: 2,
        claimed: 1,
        rejected: 0,
        withdrawn: 0,
        waiting: 1,
        claim_minutes: { median: 3, p90: 3, sample: 1 },
      },
      truncated: false,
      weeks: [{ week: "2026-09-28", accepted_merged: 0, returned: 1, median_lead_hours: null, entered: 2, sent: 2, full_flow: false }],
    });
    const view = WorkOutcomes.parse(toWorkOutcomes(out));
    expect(view.leadTime).toEqual({ medianHours: null, p90Hours: null, sample: 0 });
    expect(view.cost).toEqual({ runs: 1, knownRuns: 0, total: null });
    expect(view.closed).toEqual({ cancelled: 0, declined: 1, duplicate: 2 });
  });
});
