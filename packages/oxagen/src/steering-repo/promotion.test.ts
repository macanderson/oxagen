import { jcsBytes, sha256Digest } from "@oxagen/run-evidence";
import { describe, expect, it } from "vitest";
import { fixtureRepo, organizationFixtureRepo } from "./fixture-repo";
import { readJsonLines } from "./files";
import { BRANCH_PREFIXES } from "./names";
import { classifySteeringRepoPath } from "./paths";
import {
  ledgerChainBreaks,
  promotionLineHash,
  promotionSchema,
  serializePromotionLine,
  type PromotionLine,
} from "./promotion";

const ZERO_HASH = `sha256:${"0".repeat(64)}`;

const LEDGERS = (
  [
    ["repo", fixtureRepo()],
    ["org-repo", organizationFixtureRepo()],
  ] as const
).flatMap(([tree, files]) =>
  [...files]
    .filter(([path]) => classifySteeringRepoPath(path) === "ledger")
    .map(([path, text]) => ({ tree, name: `${tree}/${path}`, text })),
);

function readLedger(text: string): PromotionLine[] {
  const read = readJsonLines(text, promotionSchema);
  if (!read.ok) throw new Error(JSON.stringify(read.issues));
  return read.value;
}

function ledgerOf(tree: string): PromotionLine[] {
  const entry = LEDGERS.find((ledger) => ledger.tree === tree);
  if (entry === undefined) throw new Error(`${tree} has no ledger`);
  return readLedger(entry.text);
}

function withoutHash(line: PromotionLine): Omit<PromotionLine, "hash"> {
  const { hash: _hash, ...rest } = line;
  return rest;
}

/** A steering PR's ledger line before Oxagen hashes it. */
function draft(seq: number, prev: string | null): Omit<PromotionLine, "hash"> {
  return {
    schema: "promotion/v1",
    seq,
    at: "2026-09-26T12:00:00Z",
    pull_request: { provider: "github", number: seq },
    branch: "steering/a-intel.test.rule",
    mode: "team",
    approved_by: ["dana"],
    merged_by: "priya",
    without_review: false,
    changes: [{ path: "steering/test/a-intel.test.rule.md", action: "added" }],
    prev,
  };
}

function hashed(line: Omit<PromotionLine, "hash">): PromotionLine {
  return { ...line, hash: promotionLineHash(line) };
}

function issuesOf(value: unknown): { path: (string | number)[]; message: string }[] {
  const result = promotionSchema.safeParse(value);
  return result.success
    ? []
    : result.error.issues.map(({ path, message }) => ({ path, message }));
}

describe("fixture ledgers", () => {
  it.each(["repo", "org-repo"])("%s holds a ledger", (tree) => {
    expect(LEDGERS.some((ledger) => ledger.tree === tree)).toBe(true);
  });

  it.each(LEDGERS)("$name reads as promotion/v1 lines", ({ text }) => {
    expect(readLedger(text).length).toBeGreaterThan(0);
  });

  it.each(LEDGERS)("$name carries the hash of each line's own content", ({ text }) => {
    for (const line of readLedger(text)) {
      expect(line.hash).toBe(promotionLineHash(line));
    }
  });

  it.each(LEDGERS)("$name is the serialized form of its own lines", ({ text }) => {
    const lines = readLedger(text);
    expect(lines.map((line) => serializePromotionLine(withoutHash(line))).join("")).toBe(text);
  });

  it.each(LEDGERS)("$name opens the chain and never breaks it", ({ text }) => {
    const lines = readLedger(text);
    expect(lines[0]?.prev).toBeNull();
    expect(lines[0]?.seq).toBe(1);
    expect(ledgerChainBreaks(lines, null)).toEqual([]);
  });
});

describe("ledgerChainBreaks", () => {
  const lines = ledgerOf("repo");
  const every = lines.map((_line, index) => index);
  const change = (at: number, patch: Partial<PromotionLine>) =>
    lines.map((line, index) => (index === at ? { ...line, ...patch } : line));

  it("works on a ledger long enough to break in the middle", () => {
    expect(lines.length).toBeGreaterThan(6);
  });

  it("flags a line whose hash was replaced, and the line that follows it", () => {
    expect(ledgerChainBreaks(change(3, { hash: ZERO_HASH }), null)).toEqual([3, 4]);
  });

  it("flags a line whose content changed under its hash", () => {
    expect(ledgerChainBreaks(change(3, { merged_by: "mallory" }), null)).toEqual([3]);
  });

  it("flags a line whose prev names another hash", () => {
    expect(ledgerChainBreaks(change(3, { prev: ZERO_HASH }), null)).toEqual([3]);
  });

  it("flags a line whose seq does not follow", () => {
    expect(ledgerChainBreaks(change(3, { seq: 99 }), null)).toEqual([3]);
  });

  it("flags every line after a missing one", () => {
    const dropped = lines.filter((_line, index) => index !== 3);
    expect(ledgerChainBreaks(dropped, null)).toEqual(every.slice(3, -1));
  });

  it("flags every line when the chain starts at another seq", () => {
    expect(ledgerChainBreaks(lines, null, 2)).toEqual(every);
  });

  it("flags the first line when the chain should continue from a hash", () => {
    expect(ledgerChainBreaks(lines, ZERO_HASH)).toEqual([0]);
  });

  it("accepts a run of lines that continues from the hash and seq before it", () => {
    const before = lines[4];
    expect(before).toBeDefined();
    expect(ledgerChainBreaks(lines.slice(5), before?.hash ?? null, 6)).toEqual([]);
  });

  it("accepts an empty run", () => {
    expect(ledgerChainBreaks([], null)).toEqual([]);
  });

  it("links synthetic lines the way Oxagen writes them", () => {
    const first = hashed(draft(1, null));
    const second = hashed(draft(2, first.hash));
    expect(ledgerChainBreaks([first, second], null)).toEqual([]);
    expect(ledgerChainBreaks([second], first.hash, 2)).toEqual([]);
  });
});

describe("promotion schema", () => {
  it("accepts a synthetic line", () => {
    expect(issuesOf(hashed(draft(1, null)))).toEqual([]);
  });

  it.each(BRANCH_PREFIXES)("accepts a branch under %s/", (prefix) => {
    expect(issuesOf({ ...hashed(draft(1, null)), branch: `${prefix}/x` })).toEqual([]);
  });

  it("accepts a change that replaces an earlier id, with no review in solo mode", () => {
    const line = {
      ...draft(1, null),
      mode: "solo",
      approved_by: [],
      without_review: true,
      changes: [
        {
          path: "steering/platform/a-intel.platform.no-push-to-main.md",
          action: "modified",
          lineage: "a-intel.platform.no-push-to-main",
          id: "rec_a_intel_platform_no_push_to_main_0123456789ab",
          hash: ZERO_HASH,
          replaces: "rec_a_intel_platform_no_push_to_main_ba9876543210",
        },
      ],
    };
    expect(issuesOf({ ...line, hash: ZERO_HASH })).toEqual([]);
  });

  it("requires the hash", () => {
    expect(issuesOf(draft(1, null))).toEqual([{ path: ["hash"], message: "Required" }]);
  });

  it.each([
    ["a branch under no known prefix", { branch: "feature/x" }, ["branch"]],
    ["a branch that is only a prefix and a slash", { branch: "steering/" }, ["branch"]],
    ["a branch that is only a prefix", { branch: "steering" }, ["branch"]],
    ["a steering PR that changed nothing", { changes: [] }, ["changes"]],
    ["an unknown provider", { pull_request: { provider: "bitbucket", number: 1 } }, ["pull_request", "provider"]],
    ["a pull request number of zero", { pull_request: { provider: "github", number: 0 } }, ["pull_request", "number"]],
    ["a seq of zero", { seq: 0 }, ["seq"]],
    ["a fractional seq", { seq: 1.5 }, ["seq"]],
    ["a time with no offset", { at: "2026-09-26T12:00:00" }, ["at"]],
    ["an unknown mode", { mode: "chaos" }, ["mode"]],
    ["an approver with capitals", { approved_by: ["Dana"] }, ["approved_by", 0]],
    ["an empty merged_by", { merged_by: "" }, ["merged_by"]],
    ["a prev that is not a sha256", { prev: "abc" }, ["prev"]],
    ["a hash that is not a sha256", { hash: "abc" }, ["hash"]],
    ["a field it does not know", { colour: "blue" }, []],
    [
      "an unknown action",
      { changes: [{ path: "steering/x/a-intel.x.md", action: "renamed" }] },
      ["changes", 0, "action"],
    ],
    [
      "a change path that climbs out of the repository",
      { changes: [{ path: "../x.md", action: "added" }] },
      ["changes", 0, "path"],
    ],
    [
      "a change id Oxagen would not write",
      { changes: [{ path: "steering/x/a-intel.x.md", action: "added", id: "rec_x" }] },
      ["changes", 0, "id"],
    ],
    [
      "a change field it does not know",
      { changes: [{ path: "steering/x/a-intel.x.md", action: "added", note: "x" }] },
      ["changes", 0],
    ],
  ])("refuses %s", (_name, patch, path) => {
    const issues = issuesOf({ ...hashed(draft(1, null)), ...patch });
    expect(issues.map((issue) => issue.path)).toContainEqual(path);
  });
});

describe("promotion line hash and serialization", () => {
  /** draft(1, null) with its keys written in reverse. */
  const shuffled: Omit<PromotionLine, "hash"> = {
    prev: null,
    changes: [{ action: "added", path: "steering/test/a-intel.test.rule.md" }],
    without_review: false,
    merged_by: "priya",
    approved_by: ["dana"],
    mode: "team",
    branch: "steering/a-intel.test.rule",
    pull_request: { number: 1, provider: "github" },
    at: "2026-09-26T12:00:00Z",
    seq: 1,
    schema: "promotion/v1",
  };

  it("hashes the canonical JSON of the line without its hash", () => {
    const line = draft(1, null);
    expect(promotionLineHash(line)).toBe(sha256Digest(jcsBytes(line)));
    expect(promotionLineHash(line)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("ignores the line's own hash field and its key order", () => {
    const line = draft(1, null);
    const tampered: PromotionLine = { ...hashed(line), hash: ZERO_HASH };
    expect(promotionLineHash(hashed(line))).toBe(promotionLineHash(line));
    expect(promotionLineHash(tampered)).toBe(promotionLineHash(line));
    expect(promotionLineHash(shuffled)).toBe(promotionLineHash(line));
  });

  it("changes the hash when the content changes", () => {
    const line = draft(1, null);
    expect(promotionLineHash({ ...line, merged_by: "dana" })).not.toBe(promotionLineHash(line));
    expect(promotionLineHash(draft(1, ZERO_HASH))).not.toBe(promotionLineHash(line));
  });

  it("writes one line in the schema's key order, with its hash and a newline", () => {
    const text = serializePromotionLine(shuffled);
    expect(text).toBe(serializePromotionLine(draft(1, null)));
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.slice(0, -1)).not.toContain("\n");
    const parsed = promotionSchema.parse(JSON.parse(text));
    expect(Object.keys(JSON.parse(text) as object)).toEqual(Object.keys(promotionSchema.shape));
    expect(parsed.hash).toBe(promotionLineHash(shuffled));
    expect(text).toContain('"pull_request":{"provider":"github","number":1}');
    expect(text).toContain(
      '"changes":[{"path":"steering/test/a-intel.test.rule.md","action":"added"}]',
    );
  });

  it("refuses to write a line the schema refuses", () => {
    expect(() => serializePromotionLine({ ...draft(1, null), seq: 0 })).toThrow();
  });
});
