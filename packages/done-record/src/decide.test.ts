// decide.test.ts: the four verdicts, the criterion states, and the reason codes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sha256Digest } from "@oxagen/run-evidence";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  decide,
  type CheckEvidence,
  type CriterionEvidence,
  type DoneEvidence,
  type DoneUsage,
  type OracleEvidence,
} from "./decide";
import { lockDigest } from "./lock-digest";
import type { BudgetCheck, Criterion, DoneRecord } from "./types";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const AT = "2026-09-26T18:04:11Z";
const EV = `sha256:${"b".repeat(64)}` as Sha256Digest;
const MODELS = { drafting: "triage-second", build: ["build-model"] } as const;

const pass: CheckEvidence = { ok: true, evidence: EV };
const fail: CheckEvidence = { ok: false, evidence: EV };

function oracle(overrides: Partial<OracleEvidence> = {}): OracleEvidence {
  return { ok: true, evidence: EV, contained: true, model: "verify-model", ...overrides };
}

/** The record with a lock whose digest matches it. */
function locked(record: DoneRecord): DoneRecord {
  const { lock: _lock, ...rest } = record;
  return { ...rest, lock: { digest: lockDigest(rest), by: "priya", at: AT } };
}

/** The spec's example, locked for real. */
function specExample(): DoneRecord {
  return locked(parseYaml(readFileSync(join(FIXTURES, "done-record.yaml"), "utf8")) as DoneRecord);
}

/** The spec's example without c4, its human check. */
function withoutHuman(): DoneRecord {
  const record = specExample();
  return locked({ ...record, criteria: record.criteria.filter((criterion) => criterion.id !== "c4") });
}

function recordOf(criteria: Criterion[]): DoneRecord {
  return locked({ schema: "done-record/v1", item: "wi_01K5ZQ4M8T2DXW", lineage: "aintel.platform.export", criteria });
}

/** Evidence where every check passes, every oracle qualifies, and sam signs c4. */
function allPass(): CriterionEvidence[] {
  return [
    { id: "c1", check: pass, oracle: oracle() },
    { id: "c2", check: pass, oracle: oracle() },
    { id: "c3", oracle: oracle() },
    { id: "c4", signature: { by: "sam", at: AT } },
  ];
}

function run(record: DoneRecord, criteria: CriterionEvidence[], extra: Partial<DoneEvidence> = {}) {
  return decide({ record, criteria, models: MODELS, ...extra });
}

function states(outcome: ReturnType<typeof decide>): Record<string, string> {
  return Object.fromEntries(outcome.criteria.map(({ id, state }) => [id, state]));
}

/** Replace one criterion's evidence in a list. */
function swap(list: CriterionEvidence[], entry: CriterionEvidence): CriterionEvidence[] {
  return list.map((item) => (item.id === entry.id ? entry : item));
}

describe("decide on the spec's example", () => {
  it("is pending with no evidence, and every criterion is open", () => {
    const outcome = run(specExample(), []);
    expect(outcome).toEqual({
      verdict: "pending",
      reasons: [],
      criteria: [
        { id: "c1", state: "open" },
        { id: "c2", state: "open" },
        { id: "c3", state: "open" },
        { id: "c4", state: "open" },
      ],
    });
  });

  it("is held, never proven, when a human check is signed and every oracle qualifies", () => {
    const outcome = run(specExample(), allPass());
    expect(outcome.verdict).toBe("held");
    expect(outcome.reasons).toEqual([]);
    expect(states(outcome)).toEqual({ c1: "proven", c2: "proven", c3: "proven", c4: "held" });
  });

  it("is proven once the human check is gone and every oracle qualifies", () => {
    const outcome = run(withoutHuman(), allPass().filter((entry) => entry.id !== "c4"));
    expect(outcome.verdict).toBe("proven");
    expect(states(outcome)).toEqual({ c1: "proven", c2: "proven", c3: "proven" });
  });

  it("is broken when a check fails", () => {
    const outcome = run(specExample(), swap(allPass(), { id: "c1", check: fail, oracle: oracle() }));
    expect(outcome.verdict).toBe("broken");
    expect(outcome.reasons).toEqual([{ code: "CHECK_FAILED", criterion: "c1" }]);
    expect(states(outcome).c1).toBe("failed");
  });

  it("is pending on a person when only a signature is outstanding", () => {
    const outcome = run(specExample(), allPass().filter((entry) => entry.id !== "c4"));
    expect(outcome.verdict).toBe("pending");
    expect(outcome.reasons).toEqual([{ code: "HUMAN_PENDING", criterion: "c4" }]);
  });

  it("keeps waiting when someone other than the named person signs", () => {
    const outcome = run(specExample(), swap(allPass(), { id: "c4", signature: { by: "alex", at: AT } }));
    expect(outcome.verdict).toBe("pending");
    expect(outcome.reasons).toEqual([{ code: "HUMAN_PENDING", criterion: "c4" }]);
    expect(states(outcome).c4).toBe("open");
  });

  it("marks a claimed criterion claimed until its check reports", () => {
    const outcome = run(specExample(), [{ id: "c1", claimedBy: "build-agent" }]);
    expect(states(outcome).c1).toBe("claimed");
    expect(outcome.verdict).toBe("pending");
  });

  it("never proves a criterion with a human check, even when its oracle qualifies", () => {
    const record = recordOf([
      { id: "c1", text: "The tests pass.", tag: "test", check: { run: "pnpm test" }, oracle: { class: "executable" } },
      { id: "c2", text: "The page reads well.", tag: "review", check: { human: "sam" }, oracle: { class: "predicate" } },
    ]);
    const outcome = run(record, [
      { id: "c1", check: pass, oracle: oracle() },
      { id: "c2", oracle: oracle(), signature: { by: "sam", at: AT } },
    ]);
    expect(states(outcome)).toEqual({ c1: "proven", c2: "proven" });
    expect(outcome.verdict).toBe("held");
  });
});

describe("oracle qualification", () => {
  const base = () => allPass().filter((entry) => entry.id !== "c4");

  it.each<[string, Partial<OracleEvidence>]>([
    ["the runtime was not contained", { contained: false }],
    ["a build stage ran the verify model", { model: "build-model" }],
    ["the drafting model verified", { model: "triage-second" }],
    ["the gateway recorded no model", { model: "" }],
  ])("holds c1 instead of proving it when %s", (_name, overrides) => {
    const outcome = run(withoutHuman(), swap(base(), { id: "c1", check: pass, oracle: oracle(overrides) }));
    expect(states(outcome).c1).toBe("held");
    expect(outcome.verdict).toBe("held");
  });

  it("does not prove on the record's drafting model when the gateway names another", () => {
    const outcome = run(withoutHuman(), swap(base(), { id: "c1", check: pass, oracle: oracle({ model: "triage-second" }) }), {
      models: { drafting: "other-drafter", build: ["build-model"] },
    });
    expect(states(outcome).c1).toBe("held");
    expect(outcome.verdict).toBe("held");
  });

  it("does not prove when no build model was recorded", () => {
    const outcome = run(withoutHuman(), base(), { models: { drafting: "triage-second", build: [] } });
    expect(states(outcome)).toEqual({ c1: "held", c2: "held", c3: "held" });
    expect(outcome.verdict).toBe("held");
  });

  it("does not prove when a build stage ran the drafting model", () => {
    const outcome = run(withoutHuman(), base(), { models: { drafting: "triage-second", build: ["build-model", "triage-second"] } });
    expect(outcome.verdict).toBe("held");
  });

  it("does not prove a model-drafted record when the gateway recorded no drafting model", () => {
    const outcome = run(withoutHuman(), base(), { models: { build: ["build-model"] } });
    expect(states(outcome).c1).toBe("held");
    expect(outcome.verdict).toBe("held");
  });

  it("proves a record a person wrote when no drafting model was recorded", () => {
    const { drafted_by: _drafted, ...rest } = withoutHuman();
    const outcome = run(locked(rest), base(), { models: { build: ["build-model"] } });
    expect(outcome.verdict).toBe("proven");
  });

  it("holds a record with no oracle at all", () => {
    const record = recordOf([{ id: "c1", text: "The tests pass.", tag: "test", check: { run: "pnpm test" } }]);
    const outcome = run(record, [{ id: "c1", check: pass }]);
    expect(outcome).toEqual({ verdict: "held", reasons: [], criteria: [{ id: "c1", state: "held" }] });
  });

  it("holds an oracle-only criterion when its oracle passed without qualifying", () => {
    const outcome = run(withoutHuman(), swap(base(), { id: "c3", oracle: oracle({ contained: false }) }));
    expect(states(outcome).c3).toBe("held");
  });
});

describe("lock and evidence integrity", () => {
  it("is broken with LOCK_MISMATCH when the record has no lock", () => {
    const { lock: _lock, ...unlocked } = specExample();
    const outcome = run(unlocked, allPass());
    expect(outcome.verdict).toBe("broken");
    expect(outcome.reasons).toEqual([{ code: "LOCK_MISMATCH" }]);
  });

  it("is broken with LOCK_MISMATCH when the record changed after its lock", () => {
    const record = specExample();
    const outcome = run({ ...record, lineage: "aintel.platform.other" }, allPass());
    expect(outcome.reasons).toContainEqual({ code: "LOCK_MISMATCH" });
    expect(outcome.verdict).toBe("broken");
  });

  it("reports evidence for an unknown criterion once", () => {
    const outcome = run(specExample(), [...allPass(), { id: "c9", check: pass }, { id: "c9", check: pass }]);
    expect(outcome.verdict).toBe("broken");
    expect(outcome.reasons).toEqual([{ code: "EVIDENCE_INVALID", criterion: "c9" }]);
  });

  it("fails a criterion whose evidence arrives twice", () => {
    const outcome = run(specExample(), [...allPass(), { id: "c1", check: pass, oracle: oracle() }]);
    expect(outcome.reasons).toEqual([{ code: "EVIDENCE_INVALID", criterion: "c1" }]);
    expect(states(outcome).c1).toBe("failed");
  });

  it.each<[string, CriterionEvidence]>([
    ["a check result for a criterion with no check", { id: "c3", check: pass, oracle: oracle() }],
    ["a check result for a human check", { id: "c4", check: pass, signature: { by: "sam", at: AT } }],
    ["a check result with a malformed digest", { id: "c1", check: { ok: true, evidence: "sha256:xyz" }, oracle: oracle() }],
    ["an oracle result for a criterion with no oracle", { id: "c4", oracle: oracle(), signature: { by: "sam", at: AT } }],
    ["an oracle result with a malformed digest", { id: "c1", check: pass, oracle: oracle({ evidence: "sha256:xyz" }) }],
    ["a signature on a criterion a person does not decide", { id: "c1", check: pass, oracle: oracle(), signature: { by: "sam", at: AT } }],
    ["a signature by a malformed handle", { id: "c4", signature: { by: "Sam", at: AT } }],
    ["a signature with a malformed time", { id: "c4", signature: { by: "sam", at: "yesterday" } }],
  ])("fails the criterion with EVIDENCE_INVALID on %s", (_name, entry) => {
    const outcome = run(specExample(), swap(allPass(), entry));
    expect(outcome.verdict).toBe("broken");
    expect(outcome.reasons).toEqual([{ code: "EVIDENCE_INVALID", criterion: entry.id }]);
    expect(states(outcome)[entry.id]).toBe("failed");
  });
});

describe("check and oracle results", () => {
  it("reports HARNESS_ERROR when the harness could not run a check, even if it says ok", () => {
    const outcome = run(specExample(), swap(allPass(), { id: "c1", check: { ...pass, error: true }, oracle: oracle() }));
    expect(outcome.reasons).toEqual([{ code: "HARNESS_ERROR", criterion: "c1" }]);
    expect(outcome.verdict).toBe("broken");
  });

  it("reports HARNESS_ERROR when the harness could not run an oracle", () => {
    const outcome = run(specExample(), swap(allPass(), { id: "c3", oracle: oracle({ error: true }) }));
    expect(outcome.reasons).toEqual([{ code: "HARNESS_ERROR", criterion: "c3" }]);
  });

  it("reports CHECK_FAILED when an oracle fails", () => {
    const outcome = run(specExample(), swap(allPass(), { id: "c3", oracle: oracle({ ok: false }) }));
    expect(outcome.reasons).toEqual([{ code: "CHECK_FAILED", criterion: "c3" }]);
    expect(states(outcome).c3).toBe("failed");
  });

  it("reports CHECK_FAILED once when a criterion's check and oracle both fail", () => {
    const outcome = run(specExample(), swap(allPass(), { id: "c1", check: fail, oracle: oracle({ ok: false }) }));
    expect(outcome.reasons).toEqual([{ code: "CHECK_FAILED", criterion: "c1" }]);
  });

  it("waits on a human check while its oracle has not reported, with no reason yet", () => {
    const record = recordOf([
      { id: "c1", text: "The tests pass.", tag: "test", check: { run: "pnpm test" } },
      { id: "c2", text: "The page reads well.", tag: "review", check: { human: "sam" }, oracle: { class: "predicate" } },
    ]);
    const outcome = run(record, [{ id: "c1", check: pass }]);
    expect(outcome).toEqual({
      verdict: "pending",
      reasons: [],
      criteria: [
        { id: "c1", state: "held" },
        { id: "c2", state: "open" },
      ],
    });
  });
});

describe("criteria a person decides without a named check", () => {
  const record = () =>
    recordOf([
      { id: "c1", text: "The tests pass.", tag: "test", check: { run: "pnpm test" } },
      { id: "c2", text: "The release note reads well.", tag: "review" },
    ]);

  it("waits for a signature", () => {
    const outcome = run(record(), [{ id: "c1", check: pass }]);
    expect(outcome.verdict).toBe("pending");
    expect(outcome.reasons).toEqual([{ code: "HUMAN_PENDING", criterion: "c2" }]);
  });

  it("is held by any valid signature, and never proven", () => {
    const outcome = run(record(), [{ id: "c1", check: pass }, { id: "c2", signature: { by: "alex", at: AT } }]);
    expect(outcome).toEqual({
      verdict: "held",
      reasons: [],
      criteria: [
        { id: "c1", state: "held" },
        { id: "c2", state: "held" },
      ],
    });
  });
});

describe("tools checks", () => {
  const record = () =>
    recordOf([
      { id: "c1", text: "The tests pass.", tag: "test", check: { run: "pnpm test" } },
      { id: "c2", text: "The agent never calls curl.", tag: "code", check: { tools: { deny: ["Bash(curl *)"] } } },
    ]);
  const evidence: CriterionEvidence[] = [{ id: "c1", check: pass }];

  it("holds with no denial", () => {
    expect(run(record(), evidence).verdict).toBe("held");
  });

  it("fails the criterion whose rule the agent broke", () => {
    const outcome = run(record(), evidence, { denials: ["Bash(curl *)"] });
    expect(outcome.reasons).toEqual([{ code: "TOOL_DENIED", criterion: "c2" }]);
    expect(states(outcome).c2).toBe("failed");
  });

  it("breaks the record on a denial that matches no tools check", () => {
    const outcome = run(record(), evidence, { denials: ["Read(**/.env*)"] });
    expect(outcome.verdict).toBe("broken");
    expect(outcome.reasons).toEqual([{ code: "TOOL_DENIED" }]);
    expect(states(outcome).c2).toBe("held");
  });
});

describe("budget checks", () => {
  const record = (budget: BudgetCheck["budget"]) =>
    recordOf([
      { id: "c1", text: "The tests pass.", tag: "test", check: { run: "pnpm test" } },
      { id: "c2", text: "The work stays in budget.", tag: "code", check: { budget }, negative: "Going over fails." },
    ]);
  const limits = { usd: 3, tool_calls: 120, minutes: 20 };
  const within: DoneUsage = { usd: 2.5, toolCalls: 100, minutes: 10, stopAttempts: 1 };
  const evidence: CriterionEvidence[] = [{ id: "c1", check: pass }];

  it("waits until the usage arrives", () => {
    const outcome = run(record(limits), evidence);
    expect(outcome.verdict).toBe("pending");
    expect(outcome.reasons).toEqual([]);
    expect(states(outcome).c2).toBe("open");
  });

  it("holds within every limit", () => {
    expect(run(record(limits), evidence, { usage: within }).verdict).toBe("held");
  });

  it.each<[string, Partial<DoneUsage>]>([
    ["dollars", { usd: 3.01 }],
    ["tool calls", { toolCalls: 121 }],
    ["minutes", { minutes: 21 }],
  ])("fails with BUDGET_EXCEEDED over the %s limit", (_name, over) => {
    const outcome = run(record(limits), evidence, { usage: { ...within, ...over } });
    expect(outcome.reasons).toEqual([{ code: "BUDGET_EXCEEDED", criterion: "c2" }]);
  });

  it("fails with ATTEMPTS_EXHAUSTED past the default of three tries", () => {
    const outcome = run(record(limits), evidence, { usage: { ...within, stopAttempts: 4 } });
    expect(outcome.reasons).toEqual([{ code: "ATTEMPTS_EXHAUSTED", criterion: "c2" }]);
  });

  it("uses the record's own number of tries", () => {
    const outcome = run(record({ ...limits, stop_attempts: 5 }), evidence, { usage: { ...within, stopAttempts: 4 } });
    expect(outcome.verdict).toBe("held");
  });

  it("reports both codes when the work is over budget and out of tries", () => {
    const outcome = run(record(limits), evidence, { usage: { ...within, usd: 4, stopAttempts: 4 } });
    expect(outcome.reasons).toEqual([
      { code: "BUDGET_EXCEEDED", criterion: "c2" },
      { code: "ATTEMPTS_EXHAUSTED", criterion: "c2" },
    ]);
  });

  it.each<[string, Partial<DoneUsage>]>([
    ["a number that is not finite", { usd: Number.NaN }],
    ["a negative number", { minutes: -1 }],
  ])("fails with EVIDENCE_INVALID on %s", (_name, bad) => {
    const outcome = run(record(limits), evidence, { usage: { ...within, ...bad } });
    expect(outcome.reasons).toEqual([{ code: "EVIDENCE_INVALID", criterion: "c2" }]);
  });

  it("ignores a limit the record does not set", () => {
    const outcome = run(record({}), evidence, { usage: { usd: 500, toolCalls: 9000, minutes: 600, stopAttempts: 1 } });
    expect(outcome.verdict).toBe("held");
  });
});
