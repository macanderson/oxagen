import { describe, expect, it } from "vitest";
import {
  compareStatements,
  coreOf,
  effectOfText,
  sentencesOf,
  type PublishedStatement,
} from "./findings";
import type { AddedStatement } from "./statements";

/** Records as the steering repo fixture publishes them (packages/oxagen/fixtures/steering-repo). */
const NO_PUSH: PublishedStatement = {
  lineage: "a-intel.platform.no-push-to-main",
  label: "Never push to main",
  kind: "constraint",
  effect: "forbid",
  statement:
    "Do not push to `main` or force-push any shared branch. Open a pull request\nfrom a branch named for the work.",
  path: "steering/platform/a-intel.platform.no-push-to-main.md",
};
const TENANT_QUERIES: PublishedStatement = {
  lineage: "a-intel.platform.tenant-queries",
  label: "Scope every tenant query",
  kind: "code-rule",
  effect: null,
  statement: "Run every tenant query inside withTenantDb so row level security applies to it.",
  path: "steering/platform/a-intel.platform.tenant-queries.md",
};
const MIGRATIONS: PublishedStatement = {
  lineage: "a-intel.platform.migration-names",
  label: "Name migrations by timestamp",
  kind: "code-rule",
  effect: null,
  statement: "Always run the migration lint before you open a pull request.",
  path: "steering/platform/a-intel.platform.migration-names.md",
};

const RECORDS = [NO_PUSH, TENANT_QUERIES, MIGRATIONS];

function added(text: string, line = 1, path = "CLAUDE.md"): AddedStatement {
  return { path, line, text };
}

describe("effectOfText and coreOf", () => {
  it("reads a prohibition as forbid and anything else as require", () => {
    expect(effectOfText("Never push to main.")).toBe("forbid");
    expect(effectOfText("Don’t push to main.")).toBe("forbid");
    expect(effectOfText("Avoid force pushes.")).toBe("forbid");
    expect(effectOfText("Always push to main.")).toBe("require");
    expect(effectOfText("Push to main.")).toBe("require");
  });

  it("drops the words that set the effect, so both sides of a rule read alike", () => {
    expect(coreOf("Never push to main.")).toBe("push to main.");
    expect(coreOf("You must always push to main.")).toBe("push to main.");
    expect(coreOf("Do not push to `main`")).toBe("push to `main`");
  });

  it("splits a body into its sentences only when it holds more than one", () => {
    expect(sentencesOf(NO_PUSH.statement)).toEqual([
      "Do not push to `main` or force-push any shared branch.",
      "Open a pull request from a branch named for the work.",
    ]);
    expect(sentencesOf("Push to main.")).toEqual([]);
  });
});

describe("compareStatements", () => {
  it("finds a repeat: the same words as a record", () => {
    const line = added(
      "Run every tenant query inside withTenantDb so row level security applies to it.",
      12,
    );
    expect(compareStatements([line], RECORDS)).toEqual({
      findings: [
        {
          kind: "repeat",
          statement: line,
          record: {
            lineage: TENANT_QUERIES.lineage,
            label: TENANT_QUERIES.label,
            path: TENANT_QUERIES.path,
          },
        },
      ],
      fresh: [],
    });
  });

  it("finds a repeat of one sentence of a two-sentence record", () => {
    const line = added("Open a pull request from a branch named for the work.");
    const { findings } = compareStatements([line], RECORDS);
    expect(findings).toMatchObject([{ kind: "repeat", record: { lineage: NO_PUSH.lineage } }]);
  });

  it("finds a repeat that says the same thing with other force words", () => {
    const line = added("You must run the migration lint before you open a pull request.");
    const { findings } = compareStatements([line], RECORDS);
    expect(findings).toMatchObject([{ kind: "repeat", record: { lineage: MIGRATIONS.lineage } }]);
  });

  it("finds a contradiction: the record forbids what the line requires", () => {
    const line = added("Always push to `main` or force-push any shared branch.", 7, "AGENTS.md");
    expect(compareStatements([line], RECORDS)).toEqual({
      findings: [
        {
          kind: "contradiction",
          statement: line,
          record: { lineage: NO_PUSH.lineage, label: NO_PUSH.label, path: NO_PUSH.path },
        },
      ],
      fresh: [],
    });
  });

  it("finds a contradiction: the line forbids what the record requires", () => {
    const line = added("Never run the migration lint before you open a pull request.");
    const { findings } = compareStatements([line], RECORDS);
    expect(findings).toMatchObject([
      { kind: "contradiction", record: { lineage: MIGRATIONS.lineage } },
    ]);
  });

  it("keeps a line no record holds as fresh (negative)", () => {
    const line = added("The staging database resets every Sunday night at midnight UTC.");
    expect(compareStatements([line], RECORDS)).toEqual({ findings: [], fresh: [line] });
  });

  it("does not match a line that shares a few words with a record (negative)", () => {
    const line = added("Open the deploy dashboard before you push a release tag.");
    expect(compareStatements([line], RECORDS).findings).toEqual([]);
  });

  it("compares with nothing when the workspace has no records", () => {
    const line = added("Never push to main.");
    expect(compareStatements([line], [])).toEqual({ findings: [], fresh: [line] });
  });
});
