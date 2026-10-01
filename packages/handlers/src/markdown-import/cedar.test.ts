import { describe, expect, it } from "vitest";
import {
  cedarBlocks,
  hasCedar,
  normalizedPolicy,
  policyFile,
  policyIds,
} from "./cedar";

const NO_BRANCH_DELETE = [
  "# No branch delete",
  "",
  "Agents never delete a branch.",
  "",
  "```cedar",
  "forbid (principal, action == Action::\"github__delete_branch\", resource);",
  "```",
].join("\n");

const fence = (language: string, body: string) => ["```" + language, body, "```"].join("\n");

describe("hasCedar", () => {
  it("finds a fenced cedar block", () => {
    expect(hasCedar(NO_BRANCH_DELETE)).toBe(true);
  });

  it("finds a top-level permit( or forbid( statement", () => {
    expect(hasCedar("Some prose.\n\npermit(principal, action, resource);")).toBe(true);
    expect(hasCedar("forbid (principal, action, resource);")).toBe(true);
  });

  it("reads a block fenced in another language as an example (negative)", () => {
    expect(hasCedar(fence("text", "forbid (principal, action, resource);"))).toBe(false);
    expect(hasCedar(fence("js", "permit(principal, action, resource);"))).toBe(false);
    expect(hasCedar("Never delete a branch.")).toBe(false);
  });
});

describe("cedarBlocks", () => {
  it("takes each cedar block with the prose above it, and the line it starts on", () => {
    const [block] = cedarBlocks(NO_BRANCH_DELETE);
    expect(block).toEqual({
      line: 6,
      text: 'forbid (principal, action == Action::"github__delete_branch", resource);',
      prose: ["No branch delete", "", "Agents never delete a branch."],
    });
  });

  it("skips a fenced example and keeps each cedar block apart", () => {
    const text = [
      "First rule.",
      fence("cedar", "permit (principal, action, resource);"),
      "An example:",
      fence("text", "forbid (principal, action, resource);"),
      "Second rule.",
      fence("cedar", "forbid (principal, action, resource);"),
    ].join("\n");
    const blocks = cedarBlocks(text);
    expect(blocks.map((b) => b.text)).toEqual([
      "permit (principal, action, resource);",
      "forbid (principal, action, resource);",
    ]);
    expect(blocks[1]?.prose).toEqual(["An example:", "```text", "forbid (principal, action, resource);", "```", "Second rule."]);
  });

  it("reads top-level statements when the file has no cedar block", () => {
    const [block] = cedarBlocks("Staging deploys need a ticket.\n\n@id(\"staging.deploys\")\nforbid (principal, action, resource)\nunless { context.ticket };\n");
    expect(block?.line).toBe(3);
    expect(block?.text).toContain("unless { context.ticket };");
    expect(block?.prose).toEqual(["Staging deploys need a ticket."]);
  });

  it("finds nothing in a file with no Cedar", () => {
    expect(cedarBlocks("Just prose.")).toEqual([]);
  });
});

describe("policyFile", () => {
  it("writes policy/<slug>.cedar with the prose as the leading comment and an @id from the slug", () => {
    const file = policyFile({ content: NO_BRANCH_DELETE, slug: "no-branch-delete", taken: new Map() });
    expect(file.path).toBe("policy/no-branch-delete.cedar");
    expect(file.issues).toEqual([]);
    expect(file.statements).toEqual([{ id: "no-branch-delete", line: 6, effect: "forbid" }]);
    expect(file.text).toBe(
      [
        "// No branch delete",
        "//",
        "// Agents never delete a branch.",
        '@id("no-branch-delete")',
        'forbid (principal, action == Action::"github__delete_branch", resource);',
        "",
      ].join("\n"),
    );
  });

  it("keeps a statement's own @id and numbers the rest -2 and -3", () => {
    const text = fence(
      "cedar",
      [
        "permit (principal, action, resource);",
        '@id("kept.id")',
        '@decision("require_approval")',
        "forbid (principal, action, resource);",
        "forbid (principal, action, resource);",
        "// a third without an id",
        "permit (principal, action, resource);",
      ].join("\n"),
    );
    const file = policyFile({ content: text, slug: "deploys", taken: new Map() });
    expect(file.issues).toEqual([]);
    expect(file.statements.map((s) => s.id)).toEqual(["deploys", "kept.id", "deploys-2", "deploys-3"]);
    expect(file.text).toContain('@id("kept.id")\n@decision("require_approval")\nforbid');
    expect(file.text).toContain('// a third without an id\n@id("deploys-3")');
  });

  it("skips an id another policy file already uses", () => {
    const file = policyFile({
      content: fence("cedar", "permit (principal, action, resource);"),
      slug: "deploys",
      taken: new Map([["deploys", "policy/other.cedar"]]),
    });
    expect(file.statements[0]?.id).toBe("deploys-2");
  });

  it("refuses an @id another policy file holds (negative)", () => {
    const file = policyFile({
      content: fence("cedar", '@id("money.refund")\npermit (principal, action, resource);'),
      slug: "refunds",
      taken: new Map([["money.refund", "policy/money.cedar"]]),
    });
    expect(file.issues).toEqual([
      {
        statement: 1,
        id: "money.refund",
        line: 2,
        message: "Statement 1 (money.refund) has @id money.refund, which policy/money.cedar already uses.",
      },
    ]);
  });

  it("names the statement, its @id, and its line when the effect is misspelled", () => {
    const content = ["Staging", fence("cedar", '@id("staging.deploys")\npermitt (principal, action, resource);')].join("\n");
    const file = policyFile({ content, slug: "staging", taken: new Map() });
    expect(file.issues).toEqual([
      {
        statement: 1,
        id: "staging.deploys",
        line: 3,
        message: "Statement 1 (staging.deploys) has permitt where permit or forbid belongs.",
      },
    ]);
  });

  it("refuses each shape the early checks read (negative)", () => {
    const cases: [string, string][] = [
      ["forbid (principal, action, resource)", "has no semicolon at its end."],
      ["forbid principal, action, resource;", "has no scope after forbid."],
      ["forbid (action, principal, resource);", "does not name principal, action, and resource, in that order."],
      ["forbid (principal, action, resource;", "does not close."],
      ["forbid (principal, action, resource) when { context.x;", "brackets do not close."],
      ["forbid (principal, action, resource) when context.x;", "has a when clause with no braces."],
      ["forbid (principal, action, resource) because { x };", "has because where when, unless, or the closing semicolon belongs."],
      ['@id\nforbid (principal, action, resource);', "has an @id with no value."],
      ['@note("a")\n@note("b")\nforbid (principal, action, resource);', "has @note twice."],
    ];
    for (const [statement, message] of cases) {
      const file = policyFile({ content: fence("cedar", statement), slug: "case", taken: new Map() });
      expect(file.issues[0]?.message, statement).toContain(message);
    }
  });

  it("refuses an empty cedar block, and a file with no Cedar at all (negative)", () => {
    const empty = policyFile({
      content: [fence("cedar", "permit (principal, action, resource);"), fence("cedar", "")].join("\n"),
      slug: "x",
      taken: new Map(),
    });
    expect(empty.issues.map((i) => i.message)).toEqual(["The cedar block on line 5 holds no statement."]);
    const none = policyFile({ content: "Only prose.", slug: "x", taken: new Map() });
    expect(none.issues[0]?.message).toContain("holds no cedar block");
  });

  it("keeps a semicolon inside a string and a comment out of the statement split", () => {
    const file = policyFile({
      content: fence("cedar", 'forbid (principal, action, resource) when { context.note == "a;b" }; // done; really'),
      slug: "x",
      taken: new Map(),
    });
    expect(file.issues).toEqual([]);
    expect(file.statements).toHaveLength(1);
  });
});

describe("policyIds and normalizedPolicy", () => {
  it("reads every @id a policy file names", () => {
    expect(policyIds('@id("a")\npermit (principal, action, resource);\n@id ( "b" )\nforbid (principal, action, resource);')).toEqual(["a", "b"]);
  });

  it("compares policies without their comments and spacing", () => {
    expect(normalizedPolicy('// note\n@id("a")\npermit (principal, action, resource);')).toBe(
      normalizedPolicy('@id("a") permit(principal,action,resource);'),
    );
  });

  it("tells apart two policies on different actions (negative)", () => {
    expect(normalizedPolicy('forbid (principal, action == Action::"github__delete_branch", resource);')).not.toBe(
      normalizedPolicy('forbid (principal, action == Action::"github__merge", resource);'),
    );
  });
});
