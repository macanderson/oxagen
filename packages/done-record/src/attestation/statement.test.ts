import type { Sha256Digest } from "@oxagen/run-evidence";
import { describe, expect, it } from "vitest";
import type { CriterionEvidence, DoneOutcome } from "../decide";
import type { WorkItemId } from "../types";
import { doneStatement, type DoneStatementInput } from "./index";

const ITEM: WorkItemId = "wi_0123456789ABCDEFGHJKMN";
const COMMIT = "a".repeat(40);
const RECORD: Sha256Digest = `sha256:${"b".repeat(64)}`;
const CHECK_DIGEST: Sha256Digest = `sha256:${"c".repeat(64)}`;
const ORACLE_DIGEST: Sha256Digest = `sha256:${"d".repeat(64)}`;

function input(overrides: Partial<DoneStatementInput> = {}): DoneStatementInput {
  return {
    item: ITEM,
    repository: "https://github.com/acme/api",
    commit: COMMIT,
    recordDigest: RECORD,
    outcome: { verdict: "held", reasons: [], criteria: [{ id: "tests-pass", state: "held" }] },
    decidedAt: new Date("2026-09-29T12:00:00.000Z"),
    ...overrides,
  };
}

function outcome(overrides: Partial<DoneOutcome>): DoneOutcome {
  return { verdict: "broken", reasons: [], criteria: [], ...overrides };
}

const BROKEN = { verdict: "broken", reasons: [], criteria: [] };

// Each row overrides the valid input with a value doneStatement must refuse.
// The rows are untyped on purpose: most hold a value the types forbid.
const REFUSALS: [string, Record<string, unknown>, RegExp][] = [
  ["a short commit", { commit: "a".repeat(39) }, /commit must be a 40 or 64 character/],
  ["an uppercase commit", { commit: "A".repeat(40) }, /commit must be/],
  ["a bad work item id", { item: "item-1" }, /item must be a work item id/],
  [
    "an unknown verdict",
    { outcome: { ...BROKEN, verdict: "done" } },
    /verdict must be pending, held, proven, or broken/,
  ],
  ["an invalid date", { decidedAt: new Date("not a date") }, /decidedAt must be a valid date/],
  ["a repository that is not a URL", { repository: "acme/api" }, /repository must be an https URL$/],
  ["an http repository", { repository: "http://github.com/acme/api" }, /with no credentials/],
  ["a repository with a user", { repository: "https://bot@github.com/acme/api" }, /with no credentials/],
  [
    "a repository with a password",
    { repository: "https://bot:secret@github.com/acme/api" },
    /with no credentials/,
  ],
  [
    "a repository URL over 200 characters",
    { repository: `https://github.com/${"a".repeat(200)}` },
    /repository must be a string of 1 to 200 characters/,
  ],
  ["a record digest that is not sha256", { recordDigest: "md5:abc" }, /digest must be sha256/],
  [
    "an unknown reason code",
    { outcome: { ...BROKEN, reasons: [{ code: "NOPE" }] } },
    /unknown reason code "NOPE"/,
  ],
  [
    "a reason naming a bad criterion id",
    { outcome: { ...BROKEN, reasons: [{ code: "CHECK_FAILED", criterion: "Bad Id" }] } },
    /reason CHECK_FAILED names a bad criterion id/,
  ],
  [
    "more than 40 criteria",
    {
      outcome: {
        ...BROKEN,
        criteria: Array.from({ length: 41 }, (_, i) => ({ id: `c-${i}`, state: "open" })),
      },
    },
    /at most 40 criteria/,
  ],
  [
    "a bad criterion id",
    { outcome: { ...BROKEN, criteria: [{ id: "Tests Pass", state: "open" }] } },
    /criterion id "Tests Pass" is not a criterion id/,
  ],
  [
    "a criterion listed twice",
    {
      outcome: {
        ...BROKEN,
        criteria: [
          { id: "tests-pass", state: "open" },
          { id: "tests-pass", state: "held" },
        ],
      },
    },
    /criterion tests-pass appears twice/,
  ],
  [
    "an unknown criterion state",
    { outcome: { ...BROKEN, criteria: [{ id: "tests-pass", state: "done" }] } },
    /criterion tests-pass has an unknown state/,
  ],
  [
    "evidence for a criterion the outcome lacks",
    { evidence: [{ id: "other-check", check: { ok: true, evidence: CHECK_DIGEST } }] },
    /evidence names criterion "other-check", which the outcome lacks/,
  ],
  [
    "a check digest that is not sha256",
    { evidence: [{ id: "tests-pass", check: { ok: true, evidence: "sha1:x" } }] },
    /digest must be sha256/,
  ],
  [
    "an oracle with no model",
    {
      evidence: [
        { id: "tests-pass", oracle: { ok: true, evidence: ORACLE_DIGEST, contained: true, model: "" } },
      ],
    },
    /oracle model must be a string of 1 to 200 characters/,
  ],
  [
    "a signature with no signer",
    { evidence: [{ id: "tests-pass", signature: { by: "", at: "2026-09-29T11:00:00Z" } }] },
    /signature by must be/,
  ],
  [
    "a signature date that is not a string",
    { evidence: [{ id: "tests-pass", signature: { by: "a", at: 1 } }] },
    /signature at must be/,
  ],
  [
    "more than 32 stage models",
    { stageModels: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`s${i}`, "m"])) },
    /at most 32 stage models/,
  ],
  ["an empty stage name", { stageModels: { "": "m" } }, /stage must be a string/],
  [
    "a stage model over 200 characters",
    { stageModels: { build: "m".repeat(201) } },
    /model for stage build must be a string of 1 to 200 characters/,
  ],
];

describe("doneStatement", () => {
  it("builds the in-toto statement for a proven record", () => {
    const evidence: CriterionEvidence[] = [
      { id: "tests-pass", check: { ok: true, evidence: CHECK_DIGEST } },
      {
        id: "behaves-as-asked",
        oracle: { ok: true, evidence: ORACLE_DIGEST, contained: true, model: "verify-route" },
      },
      { id: "design-signed", signature: { by: "reviewer@acme.test", at: "2026-09-29T11:00:00Z" } },
    ];
    const statement = doneStatement(
      input({
        commit: "e".repeat(64),
        outcome: {
          verdict: "proven",
          reasons: [],
          criteria: [
            { id: "tests-pass", state: "proven" },
            { id: "behaves-as-asked", state: "proven" },
            { id: "design-signed", state: "proven" },
          ],
        },
        evidence,
        stageModels: { build: "build-route", verify: "verify-route" },
      }),
    );

    expect(statement).toEqual({
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name: "https://github.com/acme/api", digest: { gitCommit: "e".repeat(64) } }],
      predicateType: "https://oxagen.sh/attestations/done-record/v1",
      predicate: {
        item: ITEM,
        record_digest: RECORD,
        verdict: "proven",
        reasons: [],
        criteria: [
          { id: "tests-pass", state: "proven", evidence: { check: { ok: true, digest: CHECK_DIGEST } } },
          {
            id: "behaves-as-asked",
            state: "proven",
            evidence: {
              oracle: { ok: true, digest: ORACLE_DIGEST, contained: true, model: "verify-route" },
            },
          },
          {
            id: "design-signed",
            state: "proven",
            evidence: { signature: { by: "reviewer@acme.test", at: "2026-09-29T11:00:00Z" } },
          },
        ],
        stage_models: { build: "build-route", verify: "verify-route" },
        decided_at: "2026-09-29T12:00:00.000Z",
      },
    });
  });

  it("marks a check the harness could not run, and keeps reasons with and without a criterion", () => {
    const statement = doneStatement(
      input({
        outcome: outcome({
          reasons: [{ code: "HARNESS_ERROR", criterion: "tests-pass" }, { code: "BUDGET_EXCEEDED" }],
          criteria: [
            { id: "tests-pass", state: "failed" },
            { id: "lint-clean", state: "open" },
          ],
        }),
        evidence: [
          { id: "tests-pass", check: { ok: false, evidence: CHECK_DIGEST, error: true } },
          { id: "lint-clean", claimedBy: "agent-7" },
        ],
      }),
    );

    expect(statement.predicate.reasons).toEqual([
      { code: "HARNESS_ERROR", criterion: "tests-pass" },
      { code: "BUDGET_EXCEEDED" },
    ]);
    expect(statement.predicate.criteria).toEqual([
      {
        id: "tests-pass",
        state: "failed",
        evidence: { check: { ok: false, digest: CHECK_DIGEST, error: true } },
      },
      { id: "lint-clean", state: "open", evidence: {} },
    ]);
  });

  it("defaults to no evidence and no stage models", () => {
    const statement = doneStatement(input());
    expect(statement.predicate.criteria).toEqual([
      { id: "tests-pass", state: "held", evidence: {} },
    ]);
    expect(statement.predicate.stage_models).toEqual({});
  });

  it.each(REFUSALS)("refuses %s", (_name, overrides, message) => {
    const bad = input(overrides as Partial<DoneStatementInput>);
    expect(() => doneStatement(bad)).toThrow(message);
    expect(() => doneStatement(bad)).toThrow(TypeError);
  });
});
