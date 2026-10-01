// The statement grid's rows: a new kind narrows the force to the forces the
// kind allows (forcesFor, the rule commit_markdown_import enforces), a
// conflict blocks the steering PR until a person chooses, Replace the record
// writes over the record it beats, and the counts and the commit payload are
// what the dialog shows and sends.
import { forcesFor } from "@oxagen/oxagen/steering-repo/record-force";
import { describe, expect, it } from "vitest";
import {
  importFileResult,
  importPolicy,
  importRecord,
  parseOutput,
} from "./import.builders";
import {
  changeEffect,
  changeForce,
  changeKind,
  commitPayload,
  commitRecords,
  forceReason,
  groupsOf,
  IMPORT_KINDS,
  initialEdit,
  mergeParses,
  resolveRows,
  type RowEdit,
  rowKey,
  tally,
  wordForce,
} from "./rows";

const codeRule = importRecord({
  lineage: "acme.claude.tag-from-main",
  label: "Tag from main",
  statement: "Always tag a release from main after CI passes.",
  kind: "code-rule",
  kindReason: "It tells an agent how to work with code.",
  force: "must",
  forceWords: "Always",
  effect: null,
  tokens: 12,
});

const fact = importRecord({
  lineage: "acme.claude.api-retries",
  label: "API retries",
  statement: "The API retries a failed upstream call twice.",
  kind: "fact",
  kindReason: "It states how something is.",
  force: "info",
  forceWords: "",
  effect: null,
  tokens: 10,
});

function edits(
  ...pairs: [ReturnType<typeof importRecord>, RowEdit][]
): Map<string, RowEdit> {
  return new Map(pairs.map(([record, edit]) => [rowKey(record), edit]));
}

describe("the kind and the force", () => {
  it("offers the eight record kinds, and no decision", () => {
    expect(IMPORT_KINDS).toEqual([
      "business-rule",
      "code-rule",
      "constraint",
      "procedure",
      "skill",
      "fact",
      "preference",
      "memory",
    ]);
  });

  it.each(IMPORT_KINDS)(
    "narrows a must code rule moved to %s into the forces that kind allows",
    (kind) => {
      const next = changeKind(codeRule, initialEdit(codeRule), kind);
      expect(forcesFor(kind)).toContain(next.force);
    },
  );

  it("drops a must to may on a preference and to info on a fact or a memory", () => {
    const edit = initialEdit(codeRule);
    expect(changeKind(codeRule, edit, "preference").force).toBe("may");
    expect(changeKind(codeRule, edit, "fact").force).toBe("info");
    expect(changeKind(codeRule, edit, "memory").force).toBe("info");
  });

  it("gives a kind the force its words point to when no force was proposed for it", () => {
    // The fact's own force is info; as a procedure, no word points anywhere,
    // so the procedure's default applies.
    expect(changeKind(fact, initialEdit(fact), "procedure").force).toBe(
      "should",
    );
    const back = changeKind(
      codeRule,
      changeKind(codeRule, initialEdit(codeRule), "preference"),
      "code-rule",
    );
    expect(back.force).toBe("must");
  });

  it("gives a new constraint an effect from its words, and takes it away from any other kind", () => {
    const never = importRecord({
      kind: "business-rule",
      kindReason: "It tells an agent what to do.",
      force: "must",
      forceWords: "Never",
      effect: null,
    });
    const constraint = changeKind(never, initialEdit(never), "constraint");
    expect(constraint.effect).toBe("forbid");
    expect(changeKind(never, constraint, "procedure").effect).toBeNull();
    const require = importRecord({
      statement: "Run the linter before you push.",
      kind: "procedure",
      kindReason: "A step to follow.",
      force: "should",
      forceWords: "",
      effect: null,
    });
    expect(
      changeKind(require, initialEdit(require), "constraint").effect,
    ).toBe("require");
  });

  it("keeps a frontmatter record's kind as its file declares it (negative)", () => {
    const kept = importRecord({
      origin: "frontmatter",
      kind: "procedure",
      force: "must",
      forceWords: "",
      effect: null,
      frontmatter: "schema: steering-record/v1\nlineage: acme.core.workspace",
    });
    const edit = initialEdit(kept);
    expect(changeKind(kept, edit, "fact")).toBe(edit);
  });

  it("refuses a force the kind does not allow (negative)", () => {
    const edit = changeKind(codeRule, initialEdit(codeRule), "preference");
    expect(changeForce(edit, "must")).toBe(edit);
    expect(changeForce(edit, "info")).toEqual({
      ...edit,
      force: "info",
      forceChosen: true,
    });
  });

  it("changes the effect of a constraint only", () => {
    const constraint = initialEdit(importRecord());
    expect(changeEffect(constraint, "require").effect).toBe("require");
    const rule = initialEdit(codeRule);
    expect(changeEffect(rule, "forbid")).toBe(rule);
  });

  it("names why a row has its force", () => {
    expect(forceReason(codeRule, initialEdit(codeRule))).toBe("points");
    expect(forceReason(fact, initialEdit(fact))).toBe("only");
    expect(
      forceReason(
        codeRule,
        changeKind(codeRule, initialEdit(codeRule), "preference"),
      ),
    ).toBe("capped");
    expect(
      forceReason(fact, changeKind(fact, initialEdit(fact), "procedure")),
    ).toBe("default");
    const chosen = changeForce(initialEdit(codeRule), "should");
    expect(forceReason(codeRule, chosen)).toBe("chosen");
  });

  it("reads the words the spec names for each force", () => {
    expect(wordForce("never")).toBe("must");
    expect(wordForce("Do not")).toBe("must");
    expect(wordForce("prefer to")).toBe("should");
    expect(wordForce("consider")).toBe("may");
    expect(wordForce("")).toBeNull();
  });
});

describe("duplicates and conflicts", () => {
  const duplicate = importRecord({
    lineage: "acme.claude.no-secrets",
    statement: "Never print a secret.",
    action: "skip",
    duplicate: {
      lineage: "acme.core.no-secrets",
      path: "steering/constraints/acme.core.no-secrets.md",
      published: true,
    },
  });
  const conflict = importRecord({
    lineage: "acme.claude.merge-release",
    statement: "Merge the release pull request once CI passes.",
    kind: "constraint",
    effect: "require",
    action: null,
    conflict: {
      lineage: "acme.core.person-merges-releases",
      path: "steering/constraints/acme.core.person-merges-releases.md",
      published: true,
    },
  });

  it("starts a duplicate unticked and a conflict ticked with no choice", () => {
    const [dup, open] = resolveRows([duplicate, conflict], new Map());
    expect(dup?.action).toBe("skip");
    expect(dup?.edit.on).toBe(false);
    expect(open?.action).toBeNull();
    expect(open?.edit.on).toBe(true);
  });

  it("blocks the PR while a conflict waits, and counts it", () => {
    const rows = resolveRows([codeRule, conflict], new Map());
    expect(tally(rows, [])).toMatchObject({ records: 1, open: 1, out: 0 });
  });

  it("leaves the statement out on Keep the record", () => {
    const rows = resolveRows(
      [conflict],
      edits([conflict, { ...initialEdit(conflict), choice: "keep" }]),
    );
    expect(rows[0]).toMatchObject({
      action: "skip",
      lineage: conflict.lineage,
    });
  });

  it("writes over the published record on Replace the record", () => {
    const rows = resolveRows(
      [conflict],
      edits([conflict, { ...initialEdit(conflict), choice: "replace" }]),
    );
    expect(rows[0]).toMatchObject({
      action: "add",
      lineage: "acme.core.person-merges-releases",
    });
    expect(commitRecords(rows)[0]?.lineage).toBe(
      "acme.core.person-merges-releases",
    );
  });

  it("leaves the earlier statement out when a later one of the same import replaces it", () => {
    const earlier = importRecord({
      lineage: "acme.claude.merge-release",
      statement: "A person merges the release pull request.",
      kind: "constraint",
      effect: "forbid",
    });
    const later = importRecord({
      file: "release-flow.md",
      line: 4,
      lineage: "acme.release-flow.merge-release",
      statement: "Merge the release pull request once CI passes.",
      kind: "constraint",
      effect: "require",
      action: null,
      conflict: {
        lineage: earlier.lineage,
        path: null,
        published: false,
      },
    });
    const rows = resolveRows(
      [earlier, later],
      edits([later, { ...initialEdit(later), choice: "replace" }]),
    );
    expect(rows.map((r) => [r.action, r.replacedBy])).toEqual([
      ["skip", 1],
      ["add", null],
    ]);
  });

  it("needs no choice for a conflict row a person unticks", () => {
    const rows = resolveRows(
      [conflict],
      edits([conflict, { ...initialEdit(conflict), on: false }]),
    );
    expect(rows[0]?.action).toBe("skip");
    expect(tally(rows, []).open).toBe(0);
  });
});

describe("the counts and the commit", () => {
  it("counts the records and policies marked add, and the tokens of the must and should rows", () => {
    const policy = importPolicy();
    const skipped = importPolicy({
      file: "deploy-freeze.md",
      path: "policy/deploy-freeze.cedar",
      issues: [
        {
          statement: 1,
          id: "deploy.freeze",
          line: 9,
          message: "Statement 1 (deploy.freeze) has no semicolon at its end.",
        },
      ],
      action: "skip",
    });
    const rows = resolveRows([codeRule, fact], new Map());
    expect(tally(rows, [policy, skipped])).toEqual({
      records: 2,
      policies: 1,
      out: 0,
      open: 0,
      tokens: 12,
    });
  });

  it("sends each row with the person's kind, force, effect, and action", () => {
    const moved = changeKind(codeRule, initialEdit(codeRule), "preference");
    const rows = resolveRows(
      [codeRule, fact],
      edits([codeRule, moved], [fact, { ...initialEdit(fact), on: false }]),
    );
    expect(commitRecords(rows)).toEqual([
      { ...codeRule, kind: "preference", force: "may", effect: null },
      { ...fact, action: "skip" },
    ]);
  });

  it("sends every row when they fit one call, the rows marked add alone when they do not, and nothing when even those are too large", () => {
    const big = importRecord({
      lineage: "acme.claude.big",
      statement: "x".repeat(500),
      action: "skip",
    });
    const rows = resolveRows([codeRule, big], new Map());
    expect(commitPayload(rows, [])?.records).toHaveLength(2);
    expect(
      commitPayload(rows, [], 1_000)?.records.map((r) => r.lineage),
    ).toEqual([codeRule.lineage]);
    expect(commitPayload(rows, [], 100)).toBeNull();
  });

  it("joins the parse calls in order, and groups the rows by file", () => {
    const second = importRecord({
      file: "AGENTS.md",
      lineage: "acme.agents.use-pnpm",
      statement: "Use pnpm for every script.",
    });
    const parsed = mergeParses([
      parseOutput({ records: [codeRule] }),
      parseOutput({
        files: [importFileResult({ filename: "AGENTS.md" })],
        records: [second],
      }),
    ]);
    expect(parsed.max).toBe(299);
    const groups = groupsOf(parsed, resolveRows(parsed.records, new Map()));
    expect(
      groups.map((g) => [g.file, g.rows.map((r) => r.row.record.lineage)]),
    ).toEqual([
      ["CLAUDE.md", [codeRule.lineage]],
      ["AGENTS.md", [second.lineage]],
    ]);
  });
});
