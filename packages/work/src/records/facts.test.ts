// facts.test.ts: each fact kind comes only from its trusted source and carries
// the links it needs, and the canonical order ignores arrival.
import { describe, expect, it } from "vitest";
import { isWorkRecordError } from "./errors";
import {
  FACT_KINDS,
  FACT_SOURCES,
  FACT_SOURCES_BY_KIND,
  ITEM_FACT_KINDS,
  type MergedBy,
  ORDER_FACT_KINDS,
  type WorkFact,
  checkFact,
  compareFacts,
  isDecisionFactKind,
  isOrderFactKind,
  newFact,
  sortFacts,
  workOrderKey,
} from "./facts";
import { sourceDigest } from "./source";

const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}` as const;
const AT = "2026-10-01T10:00:00.000Z";

function base(dedupeKey: string) {
  return { itemRevision: 1, actor: "user-1", occurredAt: AT, dedupeKey };
}

function refusal(fact: WorkFact): string {
  try {
    checkFact(fact);
  } catch (error) {
    expect(isWorkRecordError(error, "invalid_input")).toBe(true);
    return (error as Error).message;
  }
  throw new Error(`expected ${fact.kind} to be refused`);
}

const snapshot = { digest: DIGEST, subject: "Fix invites", description: null, labels: ["bug"] };

/** One well-formed fact of every kind. */
const VALID: WorkFact[] = [
  newFact({ kind: "collected", source: "provider", ...base("k1"), data: snapshot }),
  newFact({ kind: "entered", source: "person", ...base("k2"), data: snapshot }),
  newFact({ kind: "source_changed", source: "provider", ...base("k3"), data: { ...snapshot, previous_digest: null } }),
  newFact({ kind: "triage_recorded", source: "oxagen", ...base("k4"), data: { decision: "tri_1", outcome: "triaged", duplicate_of: null } }),
  newFact({ kind: "triage_failed", source: "oxagen", ...base("k5"), data: { reason: "The output did not parse." } }),
  newFact({ kind: "triage_overridden", source: "person", ...base("k6"), data: { outcome: null, duplicate_of: null, reason: "Clear." } }),
  newFact({ kind: "brief_saved", source: "person", ...base("k7"), briefId: "b1", briefDigest: DIGEST, data: { revision: 1, revises: false } }),
  newFact({ kind: "brief_approved", source: "person", ...base("k8"), briefId: "b1", briefDigest: DIGEST, data: { revision: 1 } }),
  newFact({ kind: "closed", source: "person", ...base("k9"), data: { resolution: "declined", reason: "Not now." } }),
  newFact({ kind: "reopened", source: "person", ...base("k10"), data: { reason: "Back.", after_send: 0 } }),
  newFact({
    kind: "send_requested",
    source: "person",
    ...base("k11"),
    orderId: "o1",
    briefId: "b1",
    briefDigest: DIGEST,
    data: { send: 1, brief_revision: 1, key: "wi_x:r1:s1", agent_id: "a", runtime_id: "r", runtime_tier: "gateway", operator_id: "u" },
  }),
  newFact({ kind: "send_delivered", source: "oxagen", ...base("k12"), orderId: "o1", data: { command_id: null } }),
  newFact({ kind: "send_rejected", source: "runtime", ...base("k13"), orderId: "o1", data: { reason: "Signed out." } }),
  newFact({ kind: "send_withdrawn", source: "person", ...base("k14"), orderId: "o1", data: { reason: "Wrong agent." } }),
  newFact({ kind: "claimed", source: "runtime", ...base("k15"), orderId: "o1", data: { host: "tch_1" } }),
  newFact({ kind: "run_linked", source: "runtime", ...base("k16"), orderId: "o1", runId: "tse_abc", data: {} }),
  newFact({ kind: "run_ended", source: "runtime", ...base("k17"), orderId: "o1", runId: "arun_abc", data: { outcome: null } }),
  newFact({ kind: "stop_requested", source: "person", ...base("k18"), orderId: "o1", data: { reason: "Stop." } }),
  newFact({ kind: "stopped", source: "runtime", ...base("k19"), orderId: "o1", data: {} }),
  newFact({ kind: "pr_linked", source: "runtime", ...base("k20"), orderId: "o1", repository: "aintel/platform", prNumber: 7, data: {} }),
  newFact({ kind: "head_observed", source: "provider", ...base("k21"), orderId: "o1", repository: "aintel/platform", prNumber: 7, headSha: SHA, data: {} }),
  newFact({ kind: "checks_required", source: "provider", ...base("k22"), orderId: "o1", headSha: SHA, data: { names: ["test"] } }),
  newFact({ kind: "check_observed", source: "provider", ...base("k23"), orderId: "o1", headSha: SHA, data: { name: "test", conclusion: "success" } }),
  newFact({ kind: "criterion_claimed", source: "agent", ...base("k24"), orderId: "o1", criterionId: "c1", headSha: SHA, data: { text: "Done." } }),
  newFact({ kind: "returned", source: "person", ...base("k25"), orderId: "o1", data: { reason: "Missing test.", run_ids: ["tse_abc"] } }),
  newFact({
    kind: "accepted",
    source: "person",
    ...base("k26"),
    orderId: "o1",
    repository: "aintel/platform",
    prNumber: 7,
    headSha: SHA,
    briefDigest: DIGEST,
    data: { criteria: ["c1"], required_checks: [], run_ids: ["tse_abc", "arun_def"] },
  }),
  newFact({
    kind: "merged",
    source: "provider",
    ...base("k27"),
    orderId: "o1",
    headSha: SHA,
    data: { merge_commit: "c".repeat(40), merged_by: { login: "amara", type: "User", oxagen_app: false } },
  }),
  newFact({ kind: "pr_closed", source: "provider", ...base("k28"), orderId: "o1", data: {} }),
];

describe("fact kinds", () => {
  it("names every kind once, split into item kinds and order kinds", () => {
    expect(new Set(FACT_KINDS).size).toBe(FACT_KINDS.length);
    expect(FACT_KINDS.length).toBe(ITEM_FACT_KINDS.length + ORDER_FACT_KINDS.length);
    for (const kind of ITEM_FACT_KINDS) expect(isOrderFactKind(kind)).toBe(false);
    for (const kind of ORDER_FACT_KINDS) expect(isOrderFactKind(kind)).toBe(true);
    expect(isDecisionFactKind("accepted")).toBe(true);
    expect(isDecisionFactKind("merged")).toBe(false);
  });

  it("gives every kind at least one source, and only agents may claim", () => {
    for (const kind of FACT_KINDS) {
      expect(FACT_SOURCES_BY_KIND[kind].length).toBeGreaterThan(0);
      for (const source of FACT_SOURCES_BY_KIND[kind]) expect(FACT_SOURCES).toContain(source);
    }
    const agentKinds = FACT_KINDS.filter((kind) => FACT_SOURCES_BY_KIND[kind].includes("agent"));
    expect(agentKinds).toEqual(["criterion_claimed"]);
    expect(FACT_SOURCES_BY_KIND.accepted).toEqual(["person"]);
    expect(FACT_SOURCES_BY_KIND.merged).toEqual(["provider"]);
  });

  it("covers every kind in the fixture set", () => {
    expect(VALID.map((fact) => fact.kind).sort()).toEqual([...FACT_KINDS].sort());
  });
});

describe("checkFact", () => {
  it.each(VALID.map((fact) => [fact.kind, fact] as const))("admits a well-formed %s fact", (_kind, fact) => {
    expect(() => checkFact(fact)).not.toThrow();
  });

  it("refuses a kind its source may not record", () => {
    const accepted = VALID.find((fact) => fact.kind === "accepted")!;
    expect(refusal({ ...accepted, source: "agent" })).toContain("not agent");
    const merged = VALID.find((fact) => fact.kind === "merged")!;
    expect(refusal({ ...merged, source: "person" })).toContain("not person");
    expect(refusal({ ...merged, kind: "held" as "merged" })).toContain("not a fact kind");
  });

  it("refuses an order fact with no order and an item fact with one", () => {
    const head = VALID.find((fact) => fact.kind === "head_observed")!;
    expect(refusal({ ...head, orderId: null })).toContain("must name its work order");
    const closed = VALID.find((fact) => fact.kind === "closed")!;
    expect(refusal({ ...closed, orderId: "o1" })).toContain("names no work order");
  });

  it("refuses bad columns", () => {
    const head = VALID.find((fact) => fact.kind === "head_observed")!;
    refusal({ ...head, headSha: "abc" });
    refusal({ ...head, itemRevision: 0 });
    refusal({ ...head, actor: " " });
    refusal({ ...head, dedupeKey: "" });
    refusal({ ...head, dedupeKey: "x".repeat(2001) });
    refusal({ ...head, occurredAt: "yesterday" });
    refusal({ ...head, prNumber: 0 });
    const run = VALID.find((fact) => fact.kind === "run_linked")!;
    refusal({ ...run, runId: "run_1" });
  });

  it.each([
    ["brief_saved", "briefId"],
    ["brief_approved", "briefDigest"],
    ["send_requested", "briefId"],
    ["run_linked", "runId"],
    ["run_ended", "runId"],
    ["pr_linked", "repository"],
    ["pr_linked", "prNumber"],
    ["head_observed", "headSha"],
    ["checks_required", "headSha"],
    ["check_observed", "headSha"],
    ["merged", "headSha"],
    ["criterion_claimed", "criterionId"],
    ["accepted", "headSha"],
    ["accepted", "briefDigest"],
    ["accepted", "repository"],
    ["accepted", "prNumber"],
  ] as const)("refuses a %s fact with no %s", (kind, column) => {
    const fact = VALID.find((entry) => entry.kind === kind)!;
    refusal({ ...fact, [column]: null } as WorkFact);
  });

  it("refuses bad data", () => {
    const find = <K extends WorkFact["kind"]>(kind: K) => VALID.find((fact) => fact.kind === kind) as Extract<WorkFact, { kind: K }>;
    refusal({ ...find("collected"), data: { ...snapshot, subject: "" } });
    refusal({ ...find("collected"), data: { ...snapshot, labels: "bug" as unknown as string[] } });
    refusal({ ...find("triage_recorded"), data: { decision: "tri_1", outcome: "held" as "triaged", duplicate_of: null } });
    refusal({ ...find("triage_overridden"), data: { outcome: "proven" as "triaged", duplicate_of: null, reason: "x" } });
    refusal({ ...find("triage_overridden"), data: { outcome: null, duplicate_of: null, reason: "" } });
    refusal({ ...find("triage_failed"), data: { reason: "" } });
    refusal({ ...find("closed"), data: { resolution: "done" as "declined", reason: "x" } });
    refusal({ ...find("closed"), data: { resolution: "declined", reason: "" } });
    refusal({ ...find("reopened"), data: { reason: "", after_send: 0 } });
    refusal({ ...find("returned"), data: { reason: "" } });
    refusal({ ...find("send_requested"), data: { ...find("send_requested").data, runtime_tier: "cloud" as "gateway" } });
    refusal({ ...find("check_observed"), data: { name: "", conclusion: "success" } });
    refusal({ ...find("check_observed"), data: { name: "test", conclusion: "passed" as "success" } });
    refusal({ ...find("checks_required"), data: { names: "test" as unknown as string[] } });
    refusal({ ...find("checks_required"), data: { names: [""] } });
    refusal({ ...find("criterion_claimed"), data: { text: "" } });
    refusal({ ...find("accepted"), data: { criteria: "c1" as unknown as string[], required_checks: [] } });
    refusal({ ...find("returned"), data: { reason: "Missing test.", run_ids: ["run_1"] } });
    refusal({ ...find("merged"), data: { merge_commit: "abc", merged_by: null } });
  });

  it("admits a merge that names its merger or names none, and refuses one that leaves the field out or names half an account", () => {
    const merged = VALID.find((fact) => fact.kind === "merged") as Extract<WorkFact, { kind: "merged" }>;
    const commit = merged.data.merge_commit;
    const by = (mergedBy: unknown) => ({ ...merged, data: { merge_commit: commit, merged_by: mergedBy as MergedBy | null } });
    expect(() => checkFact(by({ login: "oxagen-connect[bot]", type: "Bot", oxagen_app: true }))).not.toThrow();
    expect(() => checkFact(by({ login: "github-merge-queue[bot]", type: "Bot", oxagen_app: false }))).not.toThrow();
    expect(() => checkFact(by(null))).not.toThrow();
    expect(refusal({ ...merged, data: { merge_commit: commit } })).toContain("account that merged it");
    expect(refusal(by({ login: "", type: "User", oxagen_app: false }))).toContain("login");
    expect(refusal(by({ login: "amara", type: "", oxagen_app: false }))).toContain("type");
    expect(refusal(by("amara"))).toContain("account that merged it");
    // A new merge says whether the Oxagen GitHub App made it.
    expect(refusal(by({ login: "amara", type: "User" }))).toContain("oxagen_app");
    expect(refusal(by({ login: "amara", type: "User", oxagen_app: "no" }))).toContain("oxagen_app");
  });

  it("refuses a return or an acceptance that does not list the runs linked to the send", () => {
    const find = <K extends WorkFact["kind"]>(kind: K) => VALID.find((fact) => fact.kind === kind) as Extract<WorkFact, { kind: K }>;
    expect(refusal({ ...find("accepted"), data: { criteria: ["c1"], required_checks: [] } })).toContain("lists the runs");
    expect(refusal({ ...find("returned"), data: { reason: "Missing test." } })).toContain("lists the runs");
    expect(refusal({ ...find("accepted"), data: { criteria: ["c1"], required_checks: [], run_ids: ["tse_abc", 7 as unknown as string] } })).toContain("not a run id");
  });
});

describe("compareFacts", () => {
  const at = (iso: string, kind: "head_observed" | "check_observed", key: string, revision = 1): WorkFact =>
    kind === "head_observed"
      ? newFact({ kind, source: "provider", itemRevision: revision, actor: "github", occurredAt: iso, dedupeKey: key, orderId: "o1", repository: "a/b", prNumber: 1, headSha: SHA, data: {} })
      : newFact({ kind, source: "provider", itemRevision: revision, actor: "github", occurredAt: iso, dedupeKey: key, orderId: "o1", headSha: SHA, data: { name: "t", conclusion: "success" } });

  it("orders by revision, then time, then kind, then dedupe key", () => {
    const facts = [
      at("2026-10-01T10:00:02Z", "head_observed", "e"),
      at("2026-10-01T10:00:01Z", "check_observed", "d"),
      at("2026-10-01T10:00:01Z", "head_observed", "c"),
      at("2026-10-01T09:00:00Z", "check_observed", "b", 2),
      at("2026-10-01T10:00:01Z", "head_observed", "a"),
    ];
    expect(sortFacts(facts).map((fact) => fact.dedupeKey)).toEqual(["a", "c", "d", "e", "b"]);
    expect(compareFacts(facts[0]!, facts[0]!)).toBe(0);
  });

  it("gives every arrival order the same sort", () => {
    const facts = VALID;
    const expected = sortFacts(facts).map((fact) => fact.dedupeKey);
    expect(sortFacts([...facts].reverse()).map((fact) => fact.dedupeKey)).toEqual(expected);
  });
});

describe("workOrderKey and sourceDigest", () => {
  it("names the item, the brief revision, and the send", () => {
    expect(workOrderKey("wi_abc", 2, 3)).toBe("wi_abc:r2:s3");
  });

  it("digests the material fields and ignores label order and repeats", () => {
    const a = sourceDigest({ subject: "Fix", description: "Body", labels: ["b", "a"] });
    expect(sourceDigest({ subject: "Fix", description: "Body", labels: ["a", "b", "a"] })).toBe(a);
    expect(sourceDigest({ subject: "Fix", description: null, labels: ["a", "b"] })).not.toBe(a);
    expect(sourceDigest({ subject: "Fix it", description: "Body", labels: ["a", "b"] })).not.toBe(a);
  });
});
