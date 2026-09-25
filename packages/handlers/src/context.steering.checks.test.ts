import { describe, expect, it } from "vitest";
import {
  CHECKS,
  findSecretsAndPii,
  runChecks,
  type CheckContext,
} from "./context.steering.checks";
import { buildRecordFile, serializeRecordFile } from "./context.steering.file";

const LINEAGE = "ctx.release.no-reread-changelog";
const STATEMENT = "Do not re-read CHANGELOG.md more than once in a run.";

function file(over: Partial<Parameters<typeof buildRecordFile>[0]> = {}) {
  return serializeRecordFile(
    buildRecordFile({
      lineageId: LINEAGE,
      kind: "rule",
      force: "should",
      sharingScope: "workspace",
      statement: STATEMENT,
      origin: "user",
      proposalPublicId: "prp_1",
      setId: "a-intel.platform",
      ...over,
    }),
  );
}

function ctx(over: Partial<CheckContext> = {}): CheckContext {
  return {
    fileText: file(),
    path: `.oxagen/rules/${LINEAGE}.toml`,
    changedPaths: [`.oxagen/rules/${LINEAGE}.toml`],
    proposal: {
      lineageId: LINEAGE,
      kind: "rule",
      force: "should",
      constraintEffect: null,
      sharingScope: "workspace",
      statement: STATEMENT,
      rationale: "682 duplicate tool calls across 212 runs.",
      evidenceLinks: ["frame:run_01K5RH3G8K5PAS7D/12"],
    },
    published: null,
    activeRecords: [],
    ...over,
  };
}

describe("the six §10.3 checks", () => {
  it("all pass on a well-formed first publication", async () => {
    const seen: string[] = [];
    const ok = await runChecks(ctx(), {
      start: async (name) => {
        seen.push(`start:${name}`);
      },
      finish: async (name, outcome) => {
        expect(outcome.ok, `${name}: ${outcome.summary}`).toBe(true);
        seen.push(`finish:${name}`);
      },
    });
    expect(ok).toBe(true);
    expect(seen).toEqual([
      "start:schema",
      "finish:schema",
      "start:lineage_uniqueness",
      "finish:lineage_uniqueness",
      "start:record_hash",
      "finish:record_hash",
      "start:secret_pii_scan",
      "finish:secret_pii_scan",
      "start:conflict_against_active",
      "finish:conflict_against_active",
      "start:constraint_effect",
      "finish:constraint_effect",
    ]);
  });

  it("schema: refuses a file whose kind is outside context-record/v0.1", () => {
    const text = file().replace('kind = "rule"', 'kind = "directive"');
    const out = CHECKS.schema(ctx({ fileText: text }));
    expect(out.ok).toBe(false);
    expect(out.summary).toContain('kind "directive"');
  });

  it("schema: refuses a file that is not TOML and one with the wrong schema tag", () => {
    expect(CHECKS.schema(ctx({ fileText: "schema = [broken" })).ok).toBe(false);
    const tagged = file().replace("context-record/v0.1", "context-record/v9");
    expect(CHECKS.schema(ctx({ fileText: tagged })).summary).toContain(
      "expected context-record/v0.1",
    );
  });

  it("schema: accepts a label of up to 36 characters and refuses a longer or blank one", () => {
    expect(CHECKS.schema(ctx({ fileText: file() })).ok).toBe(true);
    expect(
      CHECKS.schema(ctx({ fileText: file({ label: "a".repeat(36) }) })).ok,
    ).toBe(true);
    const long = CHECKS.schema(
      ctx({ fileText: file({ label: "a".repeat(37) }) }),
    );
    expect(long.ok).toBe(false);
    expect(long.summary).toContain("label is 1 to 36 characters");
    const blank = file({ label: "Name" }).replace(
      'label = "Name"',
      'label = "  "',
    );
    expect(CHECKS.schema(ctx({ fileText: blank })).ok).toBe(false);
  });

  it("record_hash: passes when only the label changed after stamping", () => {
    const renamed = file({ label: "Read the changelog once" }).replace(
      'label = "Read the changelog once"',
      'label = "Changelog once"',
    );
    expect(CHECKS.record_hash(ctx({ fileText: renamed })).ok).toBe(true);
  });

  it("constraint_effect: refuses a file whose label is not the one the proposal sets", () => {
    const base = ctx().proposal;
    const named = file({ label: "Read the changelog once" });
    expect(
      CHECKS.constraint_effect(
        ctx({
          fileText: named,
          proposal: { ...base, label: "Read the changelog once" },
        }),
      ).ok,
    ).toBe(true);
    const out = CHECKS.constraint_effect(
      ctx({ fileText: named, proposal: { ...base, label: "Changelog once" } }),
    );
    expect(out.ok).toBe(false);
    expect(out.summary).toContain("label");
    // A proposal that sets no label keeps whatever name the file carries.
    expect(
      CHECKS.constraint_effect(
        ctx({ fileText: named, proposal: { ...base, label: null } }),
      ).ok,
    ).toBe(true);
  });

  it("schema: refuses a pull request that changes any path besides the record file", () => {
    const out = CHECKS.schema(
      ctx({
        changedPaths: [
          ".oxagen/rules/governance.toml",
          `.oxagen/rules/${LINEAGE}.toml`,
        ],
      }),
    );
    expect(out.ok).toBe(false);
    expect(out.summary).toContain(".oxagen/rules/governance.toml");
  });

  it("lineage_uniqueness: refuses a file about another lineage, and a lineage published at another path", () => {
    const other = file({ lineageId: "ctx.release.other" });
    expect(CHECKS.lineage_uniqueness(ctx({ fileText: other })).ok).toBe(false);
    const elsewhere = CHECKS.lineage_uniqueness(
      ctx({ published: { path: ".oxagen/rules/old-name.toml", version: 2 } }),
    );
    expect(elsewhere.ok).toBe(false);
    expect(elsewhere.summary).toContain(
      "already published at .oxagen/rules/old-name.toml",
    );
    expect(
      CHECKS.lineage_uniqueness(
        ctx({ published: { path: ctx().path, version: 2 } }),
      ).summary,
    ).toContain("revises the published record");
  });

  it("lineage_uniqueness: accepts the record in any .toml file under the rules directory", () => {
    // The lineage inside the file is the record's identity (ADR-182). A team
    // that renames a file, or groups files in a folder, has not changed which
    // record it holds.
    for (const path of [
      ".oxagen/rules/read-the-changelog-once.toml",
      ".oxagen/rules/release/changelog.toml",
    ]) {
      const out = CHECKS.lineage_uniqueness(
        ctx({ path, changedPaths: [path] }),
      );
      expect(out.ok, `${path}: ${out.summary}`).toBe(true);
    }
  });

  it("lineage_uniqueness: refuses a file outside the rules directory or not TOML", () => {
    // The sync reads only .toml files under .oxagen/rules/. A record merged
    // anywhere else would never be published, so the check stops it before
    // the merge rather than after.
    for (const path of [
      ".oxagen/other/x.toml",
      "rules/x.toml",
      `.oxagen/rules.toml`,
      ".oxagen/rules/x.md",
      ".oxagen/rules/x.toml.bak",
    ]) {
      const out = CHECKS.lineage_uniqueness(
        ctx({ path, changedPaths: [path] }),
      );
      expect(out.ok, path).toBe(false);
      expect(out.summary).toContain("is not a .toml file under .oxagen/rules/");
    }
  });

  it("lineage_uniqueness: refuses a lineage already published at another rules path", () => {
    // One lineage, one file. Two files holding one lineage would leave the
    // sync to pick which one is in force.
    const out = CHECKS.lineage_uniqueness(
      ctx({
        path: ".oxagen/rules/renamed.toml",
        changedPaths: [".oxagen/rules/renamed.toml"],
        published: { path: `.oxagen/rules/${LINEAGE}.toml`, version: 4 },
      }),
    );
    expect(out.ok).toBe(false);
    expect(out.summary).toContain(
      `already published at .oxagen/rules/${LINEAGE}.toml`,
    );
    // The same renamed file, where the published record already lives, is a
    // revision in place.
    expect(
      CHECKS.lineage_uniqueness(
        ctx({
          path: ".oxagen/rules/renamed.toml",
          changedPaths: [".oxagen/rules/renamed.toml"],
          published: { path: ".oxagen/rules/renamed.toml", version: 4 },
        }),
      ).summary,
    ).toContain("revises the published record");
  });

  it("lineage_uniqueness: does not hold a record published outside the rules directory against a new file", () => {
    // Characterization of the ADR-182 change, not a rule stated anywhere
    // else: a published path outside .oxagen/rules/ (a record the sync can
    // never read back) no longer blocks the lineage, and neither does a
    // published record with no path.
    for (const published of [
      { path: "docs/steering/old.toml", version: 2 },
      { path: null, version: 2 },
    ]) {
      const out = CHECKS.lineage_uniqueness(ctx({ published }));
      expect(out.ok, `${published.path}: ${out.summary}`).toBe(true);
      expect(out.summary).toContain("revises the published record");
    }
  });

  it("record_hash: refuses a file whose statement changed after stamping", () => {
    const edited = file().replace(STATEMENT, `${STATEMENT} Edited.`);
    const out = CHECKS.record_hash(ctx({ fileText: edited }));
    expect(out.ok).toBe(false);
    expect(out.summary).toContain("does not match the file's");
    // The summary names the likely cause and where to fix it, because the
    // person reading it on GitHub just edited the file there (#4118).
    expect(out.summary).toContain(
      "Change the record in Oxagen, not on the pull request.",
    );
    expect(CHECKS.record_hash(ctx()).summary).toContain("matches the file");
    expect(CHECKS.record_hash(ctx()).summary).not.toContain("Oxagen, not on");
  });

  it("secret_pii_scan: refuses a token in the rationale and an email in the statement", () => {
    const token = CHECKS.secret_pii_scan(
      ctx({
        proposal: {
          ...ctx().proposal,
          rationale: "see ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
        },
      }),
    );
    expect(token.ok).toBe(false);
    expect(token.summary).toContain("credential token in rationale");
    const email = CHECKS.secret_pii_scan(
      ctx({
        proposal: {
          ...ctx().proposal,
          statement: "Ask marcus@a-intel.example first.",
        },
      }),
    );
    expect(email.ok).toBe(false);
    expect(email.summary).toContain("email address in statement");
  });

  it("secret_pii_scan: leaves a git sha, a frame ref and a millisecond timestamp alone", () => {
    expect(
      findSecretsAndPii(
        "commit a4c91e2f3b8d1c0e9f7a6b5c4d3e2f1a0b9c8d7e at 1726000000000 · frame:run_01K5RH3G8K5PAS7D/12",
      ),
    ).toEqual([]);
    expect(findSecretsAndPii("-----BEGIN RSA PRIVATE KEY-----")).toEqual([
      "private key block",
    ]);
    expect(findSecretsAndPii("api_key = 0123456789abcdef")).toEqual([
      "value after sensitive key api_key",
    ]);
    expect(findSecretsAndPii("card 4111 1111 1111 1111")).toEqual([
      "payment card number",
    ]);
  });

  it("conflict_against_active: refuses a forbid against an active require on the same lineage or statement", () => {
    const forbid = {
      ...ctx().proposal,
      kind: "constraint" as const,
      constraintEffect: "forbid" as const,
    };
    const sameLineage = CHECKS.conflict_against_active(
      ctx({
        proposal: forbid,
        activeRecords: [
          {
            lineageId: LINEAGE,
            kind: "constraint",
            constraintEffect: "require",
            statement: "x",
          },
        ],
      }),
    );
    expect(sameLineage.ok).toBe(false);
    expect(sameLineage.summary).toContain("retire it first");
    const sameStatement = CHECKS.conflict_against_active(
      ctx({
        proposal: forbid,
        activeRecords: [
          {
            lineageId: "ctx.other",
            kind: "constraint",
            constraintEffect: "require",
            statement: `  ${STATEMENT.toUpperCase()} `,
          },
        ],
      }),
    );
    expect(sameStatement.ok).toBe(false);
    expect(sameStatement.summary).toContain("ctx.other is an active require");
    const fine = CHECKS.conflict_against_active(
      ctx({
        proposal: forbid,
        activeRecords: [
          {
            lineageId: "ctx.other",
            kind: "constraint",
            constraintEffect: "forbid",
            statement: STATEMENT,
          },
        ],
      }),
    );
    expect(fine.ok).toBe(true);
    expect(fine.summary).toContain("1 active record checked");
  });

  it("constraint_effect: refuses a constraint without an effect, an effect on a rule, and a file whose kind, force, scope or statement is not the proposal's", () => {
    const noEffect = CHECKS.constraint_effect(
      ctx({
        fileText: file({ kind: "constraint" }),
        proposal: {
          ...ctx().proposal,
          kind: "constraint",
          constraintEffect: null,
        },
      }),
    );
    expect(noEffect.ok).toBe(false);
    const ruleWithEffect = CHECKS.constraint_effect(
      ctx({ proposal: { ...ctx().proposal, constraintEffect: "forbid" } }),
    );
    expect(ruleWithEffect.ok).toBe(false);
    expect(ruleWithEffect.summary).toContain(
      "a rule carries no constraint_effect",
    );
    const disagree = CHECKS.constraint_effect(
      ctx({ fileText: file({ kind: "procedure" }) }),
    );
    expect(disagree.ok).toBe(false);
    expect(disagree.summary).toBe(
      'the file\'s kind is "procedure"; the proposal\'s is "rule". The file changed after Oxagen wrote it, usually through an edit or an accepted review suggestion on this pull request. Change the record in Oxagen, not on the pull request.',
    );
    // The registry is written from the proposal row: a branch commit that
    // re-stamps the file with another statement, force or scope passes the
    // hash check and fails here.
    const restamped = CHECKS.constraint_effect(
      ctx({
        fileText: file({
          statement: "Re-read CHANGELOG.md on every turn.",
          force: "must",
          sharingScope: "repository",
        }),
      }),
    );
    expect(restamped.ok).toBe(false);
    expect(restamped.summary).toContain("the file's steering.force is");
    expect(restamped.summary).toContain("the file's sharing_scope is");
    expect(restamped.summary).toContain("the file's statement is");
    const forbid = CHECKS.constraint_effect(
      ctx({
        fileText: file({ kind: "constraint" }),
        proposal: {
          ...ctx().proposal,
          kind: "constraint",
          constraintEffect: "forbid",
        },
      }),
    );
    expect(forbid).toEqual({
      ok: true,
      summary: "constraint_effect = forbid · grants nothing",
    });
  });

  it("keeps running after a failure so every problem is reported at once", async () => {
    const outcomes: boolean[] = [];
    const ok = await runChecks(ctx({ fileText: "not = [toml" }), {
      start: async () => {},
      finish: async (_name, outcome) => {
        outcomes.push(outcome.ok);
      },
    });
    expect(ok).toBe(false);
    expect(outcomes).toHaveLength(6);
    expect(outcomes.filter((o) => !o).length).toBeGreaterThanOrEqual(4);
  });
});
