// The match across parse calls, through the steering check's own pass: a
// duplicate or a conflict split across two calls is marked on the later row,
// and every mark a row's own call gave it stays.
import { describe, expect, it } from "vitest";
import { importRecord } from "./import.builders";
import { marksAcrossCalls } from "./reconcile";
import { matchRowsOf } from "./rows";

/** The first call's row and the second call's row, each unmarked by its own call. */
const first = importRecord({
  file: "api/CLAUDE.md",
  lineage: "acme.api.claude.use-pnpm",
  statement: "Use pnpm for every script in the repository.",
  kind: "code-rule",
  force: "must",
  forceWords: "",
  effect: null,
});
const second = importRecord({
  file: "web/CLAUDE.md",
  lineage: "acme.web.claude.use-pnpm",
  statement: "Use pnpm for every script in the repository.",
  kind: "code-rule",
  force: "must",
  forceWords: "",
  effect: null,
});

describe("marksAcrossCalls", () => {
  it("marks a duplicate split across two calls on the later row", () => {
    expect(marksAcrossCalls(matchRowsOf([first, second]))).toEqual([
      { duplicate: null, conflict: null },
      {
        duplicate: { lineage: first.lineage, path: null, published: false },
        conflict: null,
      },
    ]);
  });

  it("marks two constraints on one statement with opposite effects as a conflict", () => {
    const forbid = importRecord({
      file: "api/AGENTS.md",
      lineage: "acme.api.agents.force-push",
      statement: "Force-push to a release branch.",
      kind: "constraint",
      effect: "forbid",
    });
    const require = importRecord({
      file: "web/AGENTS.md",
      lineage: "acme.web.agents.force-push",
      statement: "Force-push to a release branch.",
      kind: "constraint",
      effect: "require",
    });
    const [, later] = marksAcrossCalls(matchRowsOf([forbid, require]));
    expect(later?.conflict).toEqual({
      lineage: forbid.lineage,
      path: null,
      published: false,
    });
  });

  it("keeps the mark a row's own call gave it", () => {
    const published = {
      lineage: "acme.core.use-pnpm",
      path: "steering/code-rules/acme.core.use-pnpm.md",
      published: true,
    };
    const marked = { ...second, duplicate: published, action: "skip" as const };
    expect(marksAcrossCalls(matchRowsOf([first, marked]))[1]?.duplicate).toEqual(
      published,
    );
  });

  it("leaves rows that say different things alone (negative)", () => {
    const other = importRecord({
      file: "web/CLAUDE.md",
      lineage: "acme.web.claude.node",
      statement: "Run Node 22 on every host.",
    });
    expect(marksAcrossCalls(matchRowsOf([first, other]))).toEqual([
      { duplicate: null, conflict: null },
      { duplicate: null, conflict: null },
    ]);
  });
});
