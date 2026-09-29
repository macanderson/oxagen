// The Studio draft (#4678): how staged edits combine, what the diff and the
// file list show, the definition tokens before and after, what a saved test
// loses before it is staged, and which stored edits the page can read.
import { STUDIO_DRAFT_OPS_BYTES_MAX } from "@oxagen/oxagen/contracts/tool.studio.draft.save";
import { describe, expect, it } from "vitest";
import {
  DESCRIPTION_MAX,
  type DraftOp,
  draftCount,
  draftFiles,
  draftLines,
  draftTokens,
  importedAfter,
  mergeDrafts,
  parseStoredDraft,
  readDraftOps,
  scrubTest,
  sourceRequired,
  stageChecked,
  stagedClassification,
  stagedDescription,
  unstage,
} from "./draft";

const importOf = (tool: string): DraftOp => ({ kind: "import", tool });
const removeOf = (tool: string): DraftOp => ({ kind: "remove", tool });
const classifyOf = (
  tool: string,
  risk: "low" | "medium" | "high" | "critical" = "high",
  impacts: string[] = [],
): DraftOp => ({
  kind: "classify",
  tool,
  risk,
  sideEffect: "write",
  egress: "third_party",
  impacts,
});
const describeOf = (tool: string, description: string): DraftOp => ({
  kind: "describe",
  tool,
  description,
});
const testOf = (tool: string, args = "{}"): DraftOp => ({
  kind: "test",
  tool,
  environment: "sandbox",
  args,
  request: JSON.stringify({ method: "GET", url: "https://x.example/a" }),
  raw: JSON.stringify({ status: 200, body: {} }),
  shaped: "{}",
});

/** Stage each edit in turn, failing the test if any is refused. */
function staged(...ops: DraftOp[]): readonly DraftOp[] {
  let draft: readonly DraftOp[] = [];
  for (const op of ops) {
    const next = stageChecked(draft, op);
    if (next === null) throw new Error(`refused ${op.kind} ${op.tool}`);
    draft = next;
  }
  return draft;
}

const VIEW = {
  tools: [
    { name: "create_payment", imported: true, tokens: 412 },
    { name: "list_customers", imported: true, tokens: 268 },
    { name: "create_refund", imported: false, tokens: 318 },
    { name: "search_documentation", imported: false, tokens: null },
  ],
};

describe("parseStoredDraft", () => {
  it("answers the empty draft for no text, bad JSON or a bad shape", () => {
    for (const raw of [
      null,
      "not json",
      "[]",
      JSON.stringify({ revision: -1, ops: [] }),
      JSON.stringify({ revision: 1, ops: [{ kind: "rename", tool: "a" }] }),
    ]) {
      expect(parseStoredDraft(raw)).toEqual({ revision: 0, ops: [] });
    }
  });

  it("reads a stored draft whole", () => {
    const draft = { revision: 3, ops: [importOf("create_refund")] };
    expect(parseStoredDraft(JSON.stringify(draft))).toEqual(draft);
  });
});

describe("stageChecked", () => {
  it("adds an import once", () => {
    const once = staged(importOf("create_refund"));
    expect(stageChecked(once, importOf("create_refund"))).toBe(once);
    expect(once).toEqual([importOf("create_refund")]);
  });

  it("cancels an import with a remove, and drops the tool's other edits", () => {
    const draft = staged(
      importOf("create_refund"),
      classifyOf("create_refund"),
      describeOf("create_refund", "Refunds a charge."),
      testOf("create_refund"),
      importOf("list_prices"),
    );
    expect(stageChecked(draft, removeOf("create_refund"))).toEqual([
      importOf("list_prices"),
    ]);
  });

  it("cancels a remove with an import and keeps the tool's other edits", () => {
    const draft = staged(
      classifyOf("create_payment"),
      removeOf("create_payment"),
    );
    expect(stageChecked(draft, importOf("create_payment"))).toEqual([
      classifyOf("create_payment"),
    ]);
  });

  it("replaces a second classification or description of one tool", () => {
    const draft = staged(
      classifyOf("create_payment", "high"),
      describeOf("create_payment", "First."),
      classifyOf("create_payment", "critical"),
      describeOf("create_payment", "Second."),
    );
    expect(draft).toEqual([
      classifyOf("create_payment", "critical"),
      describeOf("create_payment", "Second."),
    ]);
  });

  it("keeps each saved test as its own edit", () => {
    expect(
      staged(testOf("create_payment"), testOf("create_payment")),
    ).toHaveLength(2);
  });

  it("refuses an edit that breaks the draft's shape", () => {
    expect(stageChecked([], classifyOf("create_payment", "high", ["Moves Money"]))).toBeNull();
    expect(
      stageChecked([], describeOf("create_payment", "x".repeat(DESCRIPTION_MAX + 1))),
    ).toBeNull();
    const full: DraftOp[] = [];
    for (let index = 0; index < 2_000; index += 1) {
      full.push(testOf("create_payment", String(index)));
    }
    expect(stageChecked(full, testOf("create_payment"))).toBeNull();
  });
});

describe("unstage", () => {
  it("drops the edit at one index", () => {
    const draft = staged(importOf("a_tool"), importOf("b_tool"), importOf("c_tool"));
    expect(unstage(draft, 1)).toEqual([importOf("a_tool"), importOf("c_tool")]);
  });
});

describe("importedAfter", () => {
  it("follows a staged import or remove, else the tool's own state", () => {
    const ops = staged(importOf("create_refund"), removeOf("create_payment"));
    expect(importedAfter({ name: "create_refund", imported: false }, ops)).toBe(true);
    expect(importedAfter({ name: "create_payment", imported: true }, ops)).toBe(false);
    expect(importedAfter({ name: "list_customers", imported: true }, ops)).toBe(true);
    expect(importedAfter({ name: "list_prices", imported: false }, ops)).toBe(false);
  });
});

describe("stagedClassification and stagedDescription", () => {
  it("find the staged edit of one tool", () => {
    const ops = staged(
      classifyOf("create_payment", "critical"),
      describeOf("list_customers", "Lists customers by email."),
    );
    expect(stagedClassification("create_payment", ops)?.risk).toBe("critical");
    expect(stagedClassification("list_customers", ops)).toBeUndefined();
    expect(stagedDescription("list_customers", ops)).toBe(
      "Lists customers by email.",
    );
    expect(stagedDescription("create_payment", ops)).toBeUndefined();
  });
});

describe("draftLines, draftFiles and draftCount", () => {
  it("show nothing for an empty draft", () => {
    expect(draftLines(VIEW, [])).toEqual([]);
    expect(draftFiles(VIEW, [])).toEqual([]);
    expect(draftCount(VIEW, [])).toBe(0);
  });

  it("list additions, removals and changes in tool order", () => {
    const ops = staged(
      importOf("create_refund"),
      describeOf("list_customers", "Lists customers by email."),
      classifyOf("list_customers"),
      removeOf("create_payment"),
      testOf("list_customers"),
    );
    expect(draftLines(VIEW, ops)).toEqual([
      { change: "removed", tool: "create_payment", tokens: 412 },
      {
        change: "changed",
        tool: "list_customers",
        fields: ["classification", "description"],
      },
      { change: "added", tool: "create_refund", tokens: 318 },
    ]);
    expect(draftFiles(VIEW, ops)).toEqual([
      "tools.toml",
      "tools.lock.json",
      "tests/calls.jsonl",
    ]);
    expect(draftCount(VIEW, ops)).toBe(4);
  });

  it("change only tools.toml when every line is a change", () => {
    const ops = staged(describeOf("create_payment", "Charges a customer."));
    expect(draftFiles(VIEW, ops)).toEqual(["tools.toml"]);
  });

  it("change only the tests when the draft holds nothing else", () => {
    const ops = staged(testOf("create_payment"));
    expect(draftLines(VIEW, ops)).toEqual([]);
    expect(draftFiles(VIEW, ops)).toEqual(["tests/calls.jsonl"]);
    expect(draftCount(VIEW, ops)).toBe(1);
  });

  it("ignore an edit to a tool that stays unimported", () => {
    const ops = staged(classifyOf("create_refund"));
    expect(draftLines(VIEW, ops)).toEqual([]);
  });
});

describe("draftTokens", () => {
  it("sums the imported tools before and after the draft", () => {
    const ops = staged(importOf("create_refund"), removeOf("list_customers"));
    expect(draftTokens(VIEW, ops)).toEqual({ before: 680, after: 730 });
  });

  it("answers null once an unmeasured tool is imported", () => {
    const ops = staged(importOf("search_documentation"));
    expect(draftTokens(VIEW, ops)).toEqual({ before: 680, after: null });
  });
});

describe("scrubTest", () => {
  const request = (headers: Record<string, string>) =>
    JSON.stringify({ method: "GET", url: "https://x.example/a", headers });

  it("strips every credential header, in any case, and names each one", () => {
    const result = scrubTest({
      request: request({
        Authorization: "Bearer test-token",
        "Proxy-Authorization": "Basic test",
        Cookie: "a=b",
        accept: "application/json",
      }),
      raw: JSON.stringify({
        status: 200,
        headers: { "Set-Cookie": "s=t", "content-type": "application/json" },
        body: {},
      }),
      shaped: "{}",
    });
    expect(result).toEqual({
      ok: true,
      request: request({ accept: "application/json" }),
      raw: JSON.stringify({
        status: 200,
        headers: { "content-type": "application/json" },
        body: {},
      }),
      shaped: "{}",
      removed: ["authorization", "cookie", "proxy-authorization", "set-cookie"],
    });
  });

  it("keeps the recorded text as it came when there is nothing to strip", () => {
    const clean = request({ accept: "application/json" });
    const raw = '{"status":200,  "body":{}}';
    expect(scrubTest({ request: clean, raw, shaped: "[1]" })).toEqual({
      ok: true,
      request: clean,
      raw,
      shaped: "[1]",
      removed: [],
    });
  });

  it("refuses a record that is not a JSON object, or a shaped result that is not JSON", () => {
    const clean = request({});
    expect(scrubTest({ request: "[]", raw: "{}", shaped: "{}" })).toEqual({ ok: false });
    expect(scrubTest({ request: clean, raw: "nope", shaped: "{}" })).toEqual({ ok: false });
    expect(scrubTest({ request: clean, raw: "{}", shaped: "nope" })).toEqual({ ok: false });
  });
});

describe("sourceRequired", () => {
  it("needs the definition for any import, and always for gRPC", () => {
    expect(sourceRequired([], "grpc")).toBe(true);
    expect(sourceRequired([importOf("create_refund")], "remote")).toBe(true);
    expect(sourceRequired([importOf("create_refund")], null)).toBe(true);
    expect(sourceRequired([classifyOf("create_payment")], "openapi")).toBe(false);
    expect(sourceRequired([], null)).toBe(false);
  });
});

describe("mergeDrafts", () => {
  it("stages this tab's edits over the stored draft", () => {
    const stored = staged(
      classifyOf("create_payment", "high"),
      importOf("create_refund"),
      testOf("create_payment"),
    );
    const local = staged(
      classifyOf("create_payment", "critical"),
      testOf("create_payment"),
      removeOf("create_refund"),
      importOf("list_prices"),
    );
    expect(mergeDrafts(stored, local)).toEqual({
      ops: [
        classifyOf("create_payment", "critical"),
        testOf("create_payment"),
        importOf("list_prices"),
      ],
      dropped: 0,
    });
  });

  it("counts the edits it had to leave out", () => {
    const local: DraftOp[] = [
      classifyOf("create_payment", "high", ["Not A Tag"]),
      importOf("list_prices"),
    ];
    expect(mergeDrafts([], local)).toEqual({
      ops: [importOf("list_prices")],
      dropped: 1,
    });
  });
});

describe("readDraftOps", () => {
  const UTF8 = new TextEncoder();
  const bytesOf = (value: unknown) => UTF8.encode(JSON.stringify(value)).length;
  /** The longest raw answer, and the longest shaped result, a saved test keeps. */
  const TEXT_MAX = 262_144;
  const padded = (raw: number, shaped = 0): DraftOp => ({
    kind: "test",
    tool: "list_invoices",
    environment: "default",
    args: "{}",
    request: "{}",
    raw: "x".repeat(raw),
    shaped: "x".repeat(shaped),
  });

  /**
   * Saved tests whose edits come to exactly `bytes` as UTF-8 JSON, the way
   * save_studio_draft counts them.
   */
  function editsOfBytes(bytes: number): DraftOp[] {
    const full = padded(TEXT_MAX);
    // One edit and the comma before it. The brackets take the first edit's.
    const step = bytesOf(full) + 1;
    const floor = bytesOf(padded(0)) + 1;
    const ops: DraftOp[] = [];
    let used = 1;
    while (used + step + floor <= bytes) {
      ops.push(full);
      used += step;
    }
    const rest = bytes - used - floor;
    ops.push(padded(Math.min(rest, TEXT_MAX), Math.max(0, rest - TEXT_MAX)));
    return ops;
  }

  it("reads stored edits of every kind", () => {
    const ops = [
      importOf("create_refund"),
      removeOf("list_prices"),
      classifyOf("create_refund", "critical", ["moves_money"]),
      describeOf("create_refund", "Refund a charge."),
      testOf("create_refund"),
    ];
    expect(readDraftOps(ops)).toEqual(ops);
  });

  it("refuses an edit kind this page does not know", () => {
    expect(
      readDraftOps([importOf("create_refund"), { kind: "rename", tool: "x" }]),
    ).toBeNull();
  });

  it("refuses an edit with a field this page does not know", () => {
    expect(
      readDraftOps([{ ...importOf("create_refund"), alias: "refund" }]),
    ).toBeNull();
  });

  it("refuses more edits than a draft holds", () => {
    const ops = Array.from({ length: 2_000 }, (_, n) => importOf(`tool_${String(n)}`));
    expect(readDraftOps(ops)).toHaveLength(2_000);
    expect(readDraftOps([...ops, importOf("tool_2000")])).toBeNull();
  });

  it("holds edits up to save_studio_draft's byte limit and no further", () => {
    const atLimit = editsOfBytes(STUDIO_DRAFT_OPS_BYTES_MAX);
    expect(bytesOf(atLimit)).toBe(STUDIO_DRAFT_OPS_BYTES_MAX);
    expect(readDraftOps(atLimit)).toHaveLength(atLimit.length);

    const overLimit = editsOfBytes(STUDIO_DRAFT_OPS_BYTES_MAX + 1);
    expect(bytesOf(overLimit)).toBe(STUDIO_DRAFT_OPS_BYTES_MAX + 1);
    expect(readDraftOps(overLimit)).toBeNull();
  });
});
