import { describe, expect, it } from "vitest";
import {
  choiceKey,
  forceOf,
  forcesFor,
  hasEffect,
  isStable,
  lineageOf,
  normalizeStatement,
  type RecordChoice,
  seedStatement,
  statementTokens,
} from "./record-file";

describe("forcesFor", () => {
  it("offers every force to a rule, a constraint and a procedure", () => {
    for (const kind of ["rule", "constraint", "procedure"] as const)
      expect(forcesFor(kind)).toEqual(["must", "should", "may", "info"]);
  });

  it("never lets a preference be must or should (negative)", () => {
    expect(forcesFor("preference")).toEqual(["may", "info"]);
  });

  it("holds a fact and a memory to info (negative)", () => {
    expect(forcesFor("fact")).toEqual(["info"]);
    expect(forcesFor("memory")).toEqual(["info"]);
  });
});

describe("forceOf", () => {
  it("keeps a force the kind allows", () => {
    expect(forceOf("rule", "may")).toBe("may");
    expect(forceOf("preference", "info")).toBe("info");
  });

  it("falls back to the kind's first force when none is chosen or the kind forbids it (negative)", () => {
    expect(forceOf("rule", null)).toBe("must");
    expect(forceOf("preference", "must")).toBe("may");
    expect(forceOf("fact", "should")).toBe("info");
  });
});

describe("hasEffect and isStable", () => {
  it("gives a constraint effect to a constraint only", () => {
    expect(hasEffect("constraint")).toBe(true);
    expect(hasEffect("rule")).toBe(false);
    expect(hasEffect(null)).toBe(false);
  });

  it("puts must and should in the stable prefix, may and info in selection", () => {
    expect(isStable("must")).toBe(true);
    expect(isStable("should")).toBe(true);
    expect(isStable("may")).toBe(false);
    expect(isStable("info")).toBe(false);
  });
});

const LINEAGE = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/;

describe("lineageOf", () => {
  it("mints ctx.<workspace set>.<first four words>", () => {
    expect(
      lineageOf(
        "core-platform",
        "Do not re-read CHANGELOG.md more than once in a run",
      ),
    ).toBe("ctx.core.do-not-re-read");
  });

  it("drops stop words and punctuation, and keeps the lineage rule", () => {
    const id = lineageOf("payments", "The release manager opens the PR!");
    expect(id).toBe("ctx.payments.release-manager-opens-pr");
    expect(LINEAGE.test(id)).toBe(true);
  });

  it("names an empty description new-record, still inside the rule (negative)", () => {
    const id = lineageOf("core-platform", "   the a an   ");
    expect(id).toBe("ctx.core.new-record");
    expect(LINEAGE.test(id)).toBe(true);
  });

  it("keeps a long description inside the slug limit, with no dangling hyphen (negative)", () => {
    const id = lineageOf(
      "core",
      "supercalifragilisticexpialidocious antidisestablishmentarianism pneumonoultramicroscopic floccinaucinihilipilification",
    );
    expect(id.length).toBeLessThanOrEqual("ctx.core.".length + 48);
    expect(LINEAGE.test(id)).toBe(true);
  });
});

describe("normalizeStatement", () => {
  it("puts the statement on one line with single spaces", () => {
    expect(
      normalizeStatement(
        "Do not build or typecheck \nwhen working on a \n\tfeature. ",
      ),
    ).toBe("Do not build or typecheck when working on a feature.");
  });

  it("leaves a one-line statement as it is", () => {
    expect(normalizeStatement("Read CHANGELOG.md once.")).toBe(
      "Read CHANGELOG.md once.",
    );
  });

  it("reduces whitespace alone to nothing (negative)", () => {
    expect(normalizeStatement(" \n\t ")).toBe("");
  });
});

describe("seedStatement", () => {
  it("capitalizes the description and ends it with a full stop", () => {
    expect(seedStatement("  cache the first   read ", "rule")).toBe(
      "Cache the first read.",
    );
    expect(seedStatement("Is it cached?", "fact")).toBe("Is it cached?");
  });

  it("leaves a procedure's punctuation to its steps", () => {
    expect(seedStatement("freeze, tag, publish", "procedure")).toBe(
      "Freeze, tag, publish",
    );
  });

  it("drafts nothing from an empty description (negative)", () => {
    expect(seedStatement("   ", "rule")).toBe("");
  });
});

describe("statementTokens", () => {
  it("counts the one-line form, so a line break adds nothing", () => {
    expect(statementTokens("Read CHANGELOG.md \nonce.")).toBe(
      statementTokens("Read CHANGELOG.md once."),
    );
  });

  it("counts four characters a token over the trimmed statement", () => {
    expect(statementTokens("  12345678  ")).toBe(2);
    expect(statementTokens("")).toBe(0);
  });
});

describe("choiceKey", () => {
  const base: RecordChoice = {
    lineageId: "ctx.core.cache-changelog",
    kind: "rule",
    force: "should",
    sharingScope: "workspace",
    statement: "Cache the first read of CHANGELOG.md.",
  };

  it("is the same for the same choice", () => {
    expect(choiceKey({ ...base })).toBe(choiceKey(base));
  });

  it("changes when a word, the force or the effect changes (negative)", () => {
    expect(choiceKey({ ...base, statement: "Cache it." })).not.toBe(
      choiceKey(base),
    );
    expect(choiceKey({ ...base, label: "Release Checklist" })).not.toBe(
      choiceKey(base),
    );
    expect(choiceKey({ ...base, force: "must" })).not.toBe(choiceKey(base));
    expect(
      choiceKey({ ...base, kind: "constraint", constraintEffect: "forbid" }),
    ).not.toBe(
      choiceKey({ ...base, kind: "constraint", constraintEffect: "require" }),
    );
  });
});
