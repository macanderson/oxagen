// convert.test.ts: run dods, definitions of done, and witness records become done records.
import type { Sha256Digest } from "@oxagen/run-evidence";
import { describe, expect, it } from "vitest";
import {
  attachWitness,
  fromDefinitionOfDone,
  fromRunDod,
  type DefinitionOfDoneItem,
  type RunDod,
  type RunDodCheck,
  type WitnessLink,
  type WitnessRecord,
} from "./convert";
import { DoneRecordError } from "./errors";
import { lint, type EvaluatorPin, type EvaluatorRegistry } from "./lint";
import { lockDigest } from "./lock-digest";
import {
  CHECK_KINDS,
  ORACLE_CLASSES,
  type Check,
  type Criterion,
  type CriterionTag,
  type DoneRecord,
  type TriageDecisionId,
  type WorkItemId,
} from "./types";

const ITEM = "wi_01K5ZQ4M8T2DXW" as const;
const LINEAGE = "aintel.platform.api-keys";
const TARGET = { item: ITEM, lineage: LINEAGE, reviewer: "sam" };
const PIN = `sha256:${"a".repeat(64)}` as EvaluatorPin;
const FILE_DIGEST = `sha256:${"c".repeat(64)}` as Sha256Digest;

function fullRegistry(): EvaluatorRegistry {
  return {
    oracles: Object.fromEntries(ORACLE_CLASSES.map((cls) => [cls, PIN])) as EvaluatorRegistry["oracles"],
    checks: Object.fromEntries(CHECK_KINDS.map((kind) => [kind, PIN])) as EvaluatorRegistry["checks"],
  };
}

function errorCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof DoneRecordError) return error.code;
    throw error;
  }
  return undefined;
}

/** The run dod example from dod-spec.md. */
function specDod(): RunDod {
  return {
    dod: 1,
    task: "Add per-key rate limiting to POST /v1/keys",
    run: "run_01J9AB3K",
    locked: "sha256:4c1f9e02b77a13d4a1f0c0de5a91b26e7e4c8a0d3f1e2b9c7d6a5f4e3d2c1b0a",
    checks: [
      { id: "unit", run: "pnpm --filter @oxagen/api test:unit -- keys" },
      { id: "typecheck", run: "pnpm --filter @oxagen/api typecheck" },
      {
        id: "scope",
        diff: { allow: ["apps/api/**", "packages/rules/**"], deny: ["packages/database/migrations/**", "**/.env*"] },
      },
      { id: "wired", file: { path: "apps/api/src/routes/v1/keys.ts", contains: "rateLimit(" } },
      { id: "no-secrets", tools: { deny: ["Read(**/.env*)", "Bash(cat *.env*)", "Bash(curl *)"] } },
      { id: "budget", budget: { usd: 3, tool_calls: 120, minutes: 20, stop_attempts: 3 } },
      { id: "reviewer", human: "Endpoint behavior matches issue #2701" },
    ],
  };
}

/** Convert one run dod check and return its criterion. */
function one(check: Check): Criterion {
  const entry = { id: "c1", ...check } as RunDodCheck;
  const criterion = fromRunDod({ dod: 1, task: "t", run: "r", checks: [entry] }, TARGET).criteria[0];
  if (criterion === undefined) throw new Error("fromRunDod returned no criterion.");
  return criterion;
}

describe("fromRunDod", () => {
  it("converts the dod-spec example, one criterion per check, unlocked", () => {
    const record = fromRunDod(specDod(), TARGET);
    expect(record).toEqual({
      schema: "done-record/v1",
      item: ITEM,
      lineage: LINEAGE,
      criteria: [
        {
          id: "unit",
          text: "`pnpm --filter @oxagen/api test:unit -- keys` passes.",
          tag: "test",
          check: { run: "pnpm --filter @oxagen/api test:unit -- keys" },
        },
        {
          id: "typecheck",
          text: "`pnpm --filter @oxagen/api typecheck` passes.",
          tag: "test",
          check: { run: "pnpm --filter @oxagen/api typecheck" },
        },
        {
          id: "scope",
          text:
            "The change touches only files that match `apps/api/**` or `packages/rules/**`. " +
            "It touches nothing that matches `packages/database/migrations/**` or `**/.env*`.",
          tag: "code",
          check: {
            diff: { allow: ["apps/api/**", "packages/rules/**"], deny: ["packages/database/migrations/**", "**/.env*"] },
          },
          negative: "A change to files that match `packages/database/migrations/**` fails.",
        },
        {
          id: "wired",
          text: "`apps/api/src/routes/v1/keys.ts` contains `rateLimit(`.",
          tag: "code",
          check: { file: { path: "apps/api/src/routes/v1/keys.ts", contains: "rateLimit(" } },
        },
        {
          id: "no-secrets",
          text: "The agent never calls `Read(**/.env*)`, `Bash(cat *.env*)`, or `Bash(curl *)`.",
          tag: "code",
          check: { tools: { deny: ["Read(**/.env*)", "Bash(cat *.env*)", "Bash(curl *)"] } },
        },
        {
          id: "budget",
          text: "The work spends at most $3.00, 120 tool calls, and 20 minutes. The agent tries to finish at most 3 times.",
          tag: "code",
          check: { budget: { usd: 3, tool_calls: 120, minutes: 20, stop_attempts: 3 } },
          negative: "A run that goes over any of these limits fails.",
        },
        {
          id: "reviewer",
          text: "Endpoint behavior matches issue #2701",
          tag: "review",
          check: { human: "sam" },
        },
      ],
    });
    expect(lint(record, fullRegistry())).toEqual({ ok: true, issues: [] });
  });

  it("refuses a dod that is not version 1", () => {
    const dod = { ...specDod(), dod: 2 } as unknown as RunDod;
    expect(errorCode(() => fromRunDod(dod, TARGET))).toBe("invalid_input");
  });

  it.each<[string, { item: WorkItemId; lineage: string }]>([
    ["a work item id without wi_", { item: "task-1" as WorkItemId, lineage: LINEAGE }],
    ["a lineage that is not dotted lowercase", { item: ITEM, lineage: "Aintel.Platform" }],
    ["a lineage over 200 characters", { item: ITEM, lineage: `aintel.${"a".repeat(200)}` }],
  ])("refuses %s", (_name, target) => {
    expect(errorCode(() => fromRunDod(specDod(), { ...target, reviewer: "sam" }))).toBe("invalid_input");
  });

  it("refuses a dod with no checks or more than 40", () => {
    expect(errorCode(() => fromRunDod({ ...specDod(), checks: [] }, TARGET))).toBe("invalid_input");
    const many = Array.from({ length: 41 }, (_value, index): RunDodCheck => ({ id: `c${index}`, run: "pnpm test" }));
    expect(errorCode(() => fromRunDod({ ...specDod(), checks: many }, TARGET))).toBe("invalid_input");
  });

  it("refuses a check id that is not a criterion id, and two checks with one id", () => {
    const bad = { ...specDod(), checks: [{ id: "Unit", run: "pnpm test" }] };
    expect(errorCode(() => fromRunDod(bad, TARGET))).toBe("invalid_input");
    const twice = { ...specDod(), checks: [{ id: "unit", run: "pnpm test" }, { id: "unit", run: "pnpm lint" }] };
    expect(errorCode(() => fromRunDod(twice, TARGET))).toBe("invalid_input");
  });

  it("needs a valid reviewer for a human check", () => {
    expect(errorCode(() => fromRunDod(specDod(), { item: ITEM, lineage: LINEAGE }))).toBe("invalid_input");
    expect(errorCode(() => fromRunDod(specDod(), { ...TARGET, reviewer: "Sam" }))).toBe("invalid_input");
  });

  it("needs no reviewer when the dod has no human check", () => {
    const dod = { ...specDod(), checks: specDod().checks.filter((entry) => !("human" in entry)) };
    expect(fromRunDod(dod, { item: ITEM, lineage: LINEAGE }).criteria).toHaveLength(6);
  });

  it("quotes a command that holds a backtick as a JSON string", () => {
    expect(one({ run: "echo `date`" }).text).toBe('"echo `date`" passes.');
  });

  it.each<[string, Check, string]>([
    ["a file that must not exist", { file: { path: ".env", exists: false } }, "`.env` does not exist."],
    ["a file that must exist", { file: { path: "README.md" } }, "`README.md` exists."],
    ["a file with a digest", { file: { path: "a.ts", sha256: FILE_DIGEST } }, `\`a.ts\` matches \`${FILE_DIGEST}\`.`],
    [
      "a file with text and a digest",
      { file: { path: "a.ts", contains: "x", sha256: FILE_DIGEST } },
      `\`a.ts\` contains \`x\` and matches \`${FILE_DIGEST}\`.`,
    ],
    ["one denied tool", { tools: { deny: ["Bash(curl *)"] } }, "The agent never calls `Bash(curl *)`."],
    ["two denied tools", { tools: { deny: ["Bash(curl *)", "WebFetch"] } }, "The agent never calls `Bash(curl *)` or `WebFetch`."],
    ["a dollar limit alone", { budget: { usd: 1 } }, "The work spends at most $1.00. The agent tries to finish at most 3 times."],
    [
      "singular limits",
      { budget: { tool_calls: 1, minutes: 1, stop_attempts: 1 } },
      "The work spends at most 1 tool call and 1 minute. The agent tries to finish at most 1 time.",
    ],
    ["no limits", { budget: {} }, "The agent tries to finish at most 3 times."],
  ])("writes the text for %s", (_name, check, text) => {
    expect(one(check).text).toBe(text);
  });

  it("writes a diff that may touch any file, with no negative", () => {
    const criterion = one({ diff: { allow: ["**"] } });
    expect(criterion.text).toBe("The change may touch any file.");
    expect(criterion).not.toHaveProperty("negative");
  });

  it("writes a diff that only denies paths", () => {
    expect(one({ diff: { deny: ["migrations/**", "**/.env*", "infra/**"] } })).toMatchObject({
      text: "The change touches nothing that matches `migrations/**`, `**/.env*`, or `infra/**`.",
      negative: "A change to files that match `migrations/**` fails.",
    });
  });

  it("writes a diff that only allows paths", () => {
    expect(one({ diff: { allow: ["src/**", "tests/**", "docs/**"] } })).toMatchObject({
      text: "The change touches only files that match `src/**`, `tests/**`, or `docs/**`.",
      negative: "A change outside those paths fails.",
    });
  });
});

describe("fromDefinitionOfDone", () => {
  const items: DefinitionOfDoneItem[] = [
    { text: " The export finishes for 10,000 invoices. ", kind: "check", tag: "test", source: "issue body" },
    { text: "The docs page names the page size.", kind: "check", tag: "docs" },
    { text: "The billing owner signs off.", kind: "review", tag: "review" },
  ];

  it("gives item N the id cN, takes each check item's check, and lists the ones with none", () => {
    const drafted_by = { model: "triage-second", decision: "tri_01K5ZQ5A1C9E" as TriageDecisionId };
    const { record, unresolved } = fromDefinitionOfDone(items, {
      ...TARGET,
      checks: { c1: { run: "pnpm test -- export.large" } },
      drafted_by,
    });
    expect(record).toEqual({
      schema: "done-record/v1",
      item: ITEM,
      lineage: LINEAGE,
      drafted_by,
      criteria: [
        { id: "c1", text: "The export finishes for 10,000 invoices.", tag: "test", check: { run: "pnpm test -- export.large" } },
        { id: "c2", text: "The docs page names the page size.", tag: "docs" },
        { id: "c3", text: "The billing owner signs off.", tag: "review", check: { human: "sam" } },
      ],
    });
    expect(unresolved).toEqual(["c2"]);
  });

  it("leaves drafted_by out when a person wrote the definition", () => {
    const { record, unresolved } = fromDefinitionOfDone(items.slice(0, 1), { item: ITEM, lineage: LINEAGE });
    expect(record).not.toHaveProperty("drafted_by");
    expect(unresolved).toEqual(["c1"]);
  });

  it("refuses a check keyed to a review item or to no item", () => {
    expect(errorCode(() => fromDefinitionOfDone(items, { ...TARGET, checks: { c3: { run: "pnpm test" } } }))).toBe(
      "unknown_criterion",
    );
    expect(errorCode(() => fromDefinitionOfDone(items, { ...TARGET, checks: { c9: { run: "pnpm test" } } }))).toBe(
      "unknown_criterion",
    );
  });

  it("refuses a human check for a check item", () => {
    expect(errorCode(() => fromDefinitionOfDone(items, { ...TARGET, checks: { c1: { human: "sam" } } }))).toBe(
      "invalid_input",
    );
  });

  it.each<[string, DefinitionOfDoneItem]>([
    ["an item with no text", { text: "   ", kind: "check", tag: "test" }],
    ["an item with an unknown tag", { text: "It works.", kind: "check", tag: "ops" as CriterionTag }],
    ["an item with an unknown kind", { text: "It works.", kind: "note" as "check", tag: "test" }],
  ])("refuses %s", (_name, item) => {
    expect(errorCode(() => fromDefinitionOfDone([item], TARGET))).toBe("invalid_input");
  });

  it("needs a reviewer for a review item", () => {
    expect(errorCode(() => fromDefinitionOfDone(items, { item: ITEM, lineage: LINEAGE }))).toBe("invalid_input");
  });

  it("refuses an empty definition and a bad target", () => {
    expect(errorCode(() => fromDefinitionOfDone([], TARGET))).toBe("invalid_input");
    expect(errorCode(() => fromDefinitionOfDone(items, { ...TARGET, lineage: "x" }))).toBe("invalid_input");
  });
});

describe("attachWitness", () => {
  /** WR-0042 from witness-spec.md. */
  function wr0042(overrides: Partial<WitnessRecord["witness"]> = {}): WitnessRecord {
    return {
      witness: {
        id: "WR-0042",
        title: "refund-under-50-auto-approve",
        requirement:
          "A refund request for a delivered order under $50 is approved without human review and the customer is notified once.",
        owner: "ops@customer.example",
        oracle_classes: ["predicate", "invariant", "policy", "budget"],
        witnesses: [
          { name: "happy-path", inputs: { order: "delivered", amount: 49.99 }, expected: `sha256:${"9".repeat(64)}` },
          {
            name: "exactly-50-is-not-under",
            inputs: { order: "delivered", amount: 50 },
            expect_verdict: "REJECTED",
            reason: "POST_MISMATCH",
          },
        ],
        judgment_gated: ["Email tone matches brand voice", "  "],
        funding: { unit: "outcome:refund.approved", release_on: "STAMPED" },
        ...overrides,
      },
    };
  }

  function refundRecord(criteria?: Criterion[]): DoneRecord {
    const unlocked: DoneRecord = {
      schema: "done-record/v1",
      item: ITEM,
      lineage: "aintel.support.refunds",
      criteria: criteria ?? [
        { id: "c1", text: "A refund under $50 is approved without review.", tag: "code", check: { run: "pnpm test -- refunds" } },
        { id: "c2", text: "The customer gets one email.", tag: "test", check: { run: "pnpm test -- notify" } },
      ],
    };
    return { ...unlocked, lock: { digest: lockDigest(unlocked), by: "priya", at: "2026-09-26T18:04:11Z" } };
  }

  const predicateLink: WitnessLink = { criterion: "c1", class: "predicate", witness: "witness/WR-0042.yaml" };
  const invariantLink: WitnessLink = { criterion: "c2", class: "invariant" };
  const links = [predicateLink, invariantLink];

  it("attaches WR-0042's oracles, adds its judgment-gated item, and leaves the record unlocked", () => {
    const { record, unattached } = attachWitness(refundRecord(), wr0042(), { links, signer: "sam" });
    expect(record).toEqual({
      schema: "done-record/v1",
      item: ITEM,
      lineage: "aintel.support.refunds",
      criteria: [
        {
          id: "c1",
          text: "A refund under $50 is approved without review.",
          tag: "code",
          check: { run: "pnpm test -- refunds" },
          oracle: { class: "predicate", witness: "witness/WR-0042.yaml" },
          negative: "The `exactly-50-is-not-under` case fails with `POST_MISMATCH`.",
        },
        {
          id: "c2",
          text: "The customer gets one email.",
          tag: "test",
          check: { run: "pnpm test -- notify" },
          oracle: { class: "invariant" },
        },
        { id: "j1", text: "Email tone matches brand voice", tag: "review", check: { human: "sam" } },
      ],
    });
    expect(unattached).toEqual(["policy", "budget"]);
  });

  it("does not change the record it was given", () => {
    const original = refundRecord();
    attachWitness(original, wr0042(), { links, signer: "sam" });
    expect(original.criteria[0]).not.toHaveProperty("oracle");
    expect(original.lock).toBeDefined();
  });

  it("keeps a negative the criterion already has", () => {
    const record = refundRecord([
      { id: "c1", text: "A refund under $50 is approved.", tag: "code", check: { run: "pnpm test" }, negative: "$50.00 is refused." },
    ]);
    const { record: out } = attachWitness(record, wr0042({ judgment_gated: [] }), { links: [predicateLink] });
    expect(out.criteria[0]?.negative).toBe("$50.00 is refused.");
  });

  it("writes a negative without a reason when the case names none, and none when no case is rejected", () => {
    const noReason = wr0042({ witnesses: [{ name: "at-limit", expect_verdict: "REJECTED" }], judgment_gated: undefined });
    expect(attachWitness(refundRecord(), noReason, { links: [predicateLink] }).record.criteria[0]?.negative).toBe(
      "The `at-limit` case fails.",
    );
    const noCases = wr0042({ witnesses: undefined, judgment_gated: undefined });
    expect(attachWitness(refundRecord(), noCases, { links: [predicateLink] }).record.criteria[0]).not.toHaveProperty(
      "negative",
    );
  });

  it("gives a judgment-gated item the next free j id", () => {
    const record = refundRecord([
      { id: "c1", text: "The tests pass.", tag: "test", check: { run: "pnpm test" } },
      { id: "j1", text: "An earlier review.", tag: "review", check: { human: "alex" } },
    ]);
    const { record: out } = attachWitness(record, wr0042(), { links: [], signer: "sam" });
    expect(out.criteria.map((criterion) => criterion.id)).toEqual(["c1", "j1", "j2"]);
  });

  it("needs a valid signer only when a judgment-gated item has text", () => {
    expect(errorCode(() => attachWitness(refundRecord(), wr0042(), { links }))).toBe("invalid_input");
    expect(errorCode(() => attachWitness(refundRecord(), wr0042(), { links, signer: "Sam" }))).toBe("invalid_input");
    const blank = wr0042({ judgment_gated: ["", "  "] });
    expect(attachWitness(refundRecord(), blank, { links }).record.criteria).toHaveLength(2);
  });

  it("refuses an oracle class the spec does not define, and a link to a class the witness does not name", () => {
    const unknownClass = wr0042({ oracle_classes: ["predicate", "vibes" as "predicate"] });
    expect(errorCode(() => attachWitness(refundRecord(), unknownClass, { links, signer: "sam" }))).toBe("invalid_input");
    const unnamed = [{ criterion: "c1", class: "formal" as const }];
    expect(errorCode(() => attachWitness(refundRecord(), wr0042(), { links: unnamed, signer: "sam" }))).toBe(
      "invalid_input",
    );
  });

  it("refuses a link to a criterion the record lacks, and a second oracle on one criterion", () => {
    const missing = [{ criterion: "c9", class: "predicate" as const }];
    expect(errorCode(() => attachWitness(refundRecord(), wr0042(), { links: missing, signer: "sam" }))).toBe(
      "unknown_criterion",
    );
    const twice = [...links, { criterion: "c1", class: "policy" as const }];
    expect(errorCode(() => attachWitness(refundRecord(), wr0042(), { links: twice, signer: "sam" }))).toBe(
      "invalid_input",
    );
  });

  it("refuses a record that would hold more than 40 criteria", () => {
    const forty = Array.from({ length: 40 }, (_value, index): Criterion => ({
      id: `c${index + 1}`,
      text: "The tests pass.",
      tag: "test",
      check: { run: "pnpm test" },
    }));
    expect(errorCode(() => attachWitness(refundRecord(forty), wr0042(), { links: [], signer: "sam" }))).toBe(
      "invalid_input",
    );
  });

  describe("drafting model", () => {
    const decision = "tri_01K5ZQ5A1C9E" as TriageDecisionId;
    const draftedRecord = (): DoneRecord => ({ ...refundRecord(), drafted_by: { model: "triage-second", decision } });

    it("keeps the record's drafting model when the witness names the same one", () => {
      const out = attachWitness(draftedRecord(), wr0042({ drafted_by: "triage-second" }), { links, signer: "sam" });
      expect(out.record.drafted_by).toEqual({ model: "triage-second", decision });
    });

    it("keeps the record's drafting model when the witness names none", () => {
      const out = attachWitness(draftedRecord(), wr0042(), { links, signer: "sam" });
      expect(out.record.drafted_by).toEqual({ model: "triage-second", decision });
    });

    it("refuses two drafting models", () => {
      expect(
        errorCode(() => attachWitness(draftedRecord(), wr0042({ drafted_by: "other-model" }), { links, signer: "sam" })),
      ).toBe("drafting_conflict");
    });

    it("refuses an empty drafting model", () => {
      expect(errorCode(() => attachWitness(refundRecord(), wr0042({ drafted_by: "" }), { links, signer: "sam" }))).toBe(
        "invalid_input",
      );
    });

    it("records the witness's drafting model with the triage decision", () => {
      const out = attachWitness(refundRecord(), wr0042({ drafted_by: "witness-drafter" }), {
        links,
        signer: "sam",
        decision,
      });
      expect(out.record.drafted_by).toEqual({ model: "witness-drafter", decision });
    });

    it("needs a valid triage decision to record the witness's drafting model", () => {
      const witness = wr0042({ drafted_by: "witness-drafter" });
      expect(errorCode(() => attachWitness(refundRecord(), witness, { links, signer: "sam" }))).toBe("invalid_input");
      expect(
        errorCode(() =>
          attachWitness(refundRecord(), witness, { links, signer: "sam", decision: "tri-1" as TriageDecisionId }),
        ),
      ).toBe("invalid_input");
    });
  });
});
