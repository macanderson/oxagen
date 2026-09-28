// shape-result.ts: select, redact, and the size cap on a JSON value and on an
// MCP tools/call result, with the notes that say what was cut.
import { describe, expect, it } from "vitest";
import type { ManifestShaping } from "../contract/manifest";
import type { Paging } from "../model/upstream-tool";
import { shaping } from "./__tests__/fake-http";
import { byteLength, resultRules, shapeJson, shapeToolResult, shapeValue, visibleInput, type ResultRules } from "./shape-result";
import type { CallToolResult } from "./transport";

const CURSOR: Paging = { style: "cursor", input: "starting_after", next: "next_cursor", items: "data", limit: "limit" };

function rules(overrides: Partial<ManifestShaping> = {}, paging?: Paging): ResultRules {
  return resultRules(shaping(overrides), paging);
}

const CUT_NOTE = (max: number): string => `The result was cut at the ${max}-byte limit, so its text is incomplete.`;

const CHARGES = {
  data: [
    { id: "ch_1", amount: 500, customer: { id: "cus_1", email: "a@example.com" } },
    { id: "ch_2", amount: 700, customer: { id: "cus_2", email: "b@example.com" } },
  ],
  has_more: true,
  url: "/v1/charges",
};

/** { data: [{ id: "ch_0" }, ...], has_more: true } with count items. */
function listOf(count: number): { data: Array<{ id: string }>; has_more: boolean } {
  return { data: Array.from({ length: count }, (_, index) => ({ id: `ch_${index}` })), has_more: true };
}

function texts(result: CallToolResult): unknown[] {
  return result.content.map((item) => item.text);
}

describe("select and redact", () => {
  it("keeps only the selected paths, through a list", () => {
    expect(shapeJson(CHARGES, rules({ select: ["data[].id", "has_more"] }))).toEqual({
      data: [{ id: "ch_1" }, { id: "ch_2" }],
      has_more: true,
    });
  });

  it("keeps a whole value at a selected path, and skips a selected path that is absent", () => {
    expect(shapeJson(CHARGES, rules({ select: ["data[].customer", "next_cursor"] }))).toEqual({
      data: [{ customer: CHARGES.data[0]?.customer }, { customer: CHARGES.data[1]?.customer }],
    });
  });

  it("drops a list path whose value is not a list", () => {
    expect(shapeJson({ data: { id: "x" }, has_more: false }, rules({ select: ["data[].id", "has_more"] }))).toEqual({
      has_more: false,
    });
  });

  it("removes the redacted paths, through a list", () => {
    expect(shapeJson(CHARGES, rules({ redact: ["data[].customer.email", "url"] }))).toEqual({
      data: [
        { id: "ch_1", amount: 500, customer: { id: "cus_1" } },
        { id: "ch_2", amount: 700, customer: { id: "cus_2" } },
      ],
      has_more: true,
    });
  });

  it("selects first and then redacts", () => {
    expect(shapeJson(CHARGES, rules({ select: ["data"], redact: ["data[].customer"] }))).toEqual({
      data: [
        { id: "ch_1", amount: 500 },
        { id: "ch_2", amount: 700 },
      ],
    });
  });

  it("leaves a value that is not an object alone", () => {
    const shaped = rules({ select: ["id"], redact: ["secret"] });
    expect(shapeJson([{ secret: 1 }], shaped)).toEqual([{ secret: 1 }]);
    expect(shapeJson("text", shaped)).toBe("text");
    expect(shapeJson(undefined, shaped)).toBeUndefined();
  });
});

describe("the size-cap hint", () => {
  it("names the limit and the paging input the agent can see", () => {
    const shaped = rules({}, CURSOR);
    expect(shaped.list).toBe("data");
    expect(shaped.hint).toBe(" Set limit lower to get whole pages, and page with starting_after.");
  });

  it("uses the agent's names for renamed inputs", () => {
    const shaped = rules({ rename: { limit: "page_size", starting_after: "cursor" } }, CURSOR);
    expect(shaped.hint).toBe(" Set page_size lower to get whole pages, and page with cursor.");
  });

  it("leaves out a paging input the agent cannot set", () => {
    expect(rules({ hide: ["starting_after"] }, CURSOR).hint).toBe(" Set limit lower to get whole pages.");
    expect(rules({ fixed: { starting_after: "ch_0" } }, CURSOR).hint).toBe(" Set limit lower to get whole pages.");
  });

  it("gives no hint when the agent cannot set the limit", () => {
    expect(rules({ hide: ["limit"] }, CURSOR).hint).toBe("");
    expect(rules({ fixed: { limit: 10 } }, CURSOR).hint).toBe("");
    expect(rules({}, { style: "page", input: "page", items: "results[]" }).hint).toBe("");
  });

  it("cuts items when the tool has no paging", () => {
    const shaped = rules();
    expect(shaped.list).toBe("items");
    expect(shaped.hint).toBe("");
  });

  it("reads the list from an items path that ends in []", () => {
    expect(rules({}, { style: "page", input: "page", items: "results[]" }).list).toBe("results");
  });
});

describe("visibleInput", () => {
  it("gives the agent's name, or undefined when the agent cannot set the input", () => {
    const shaped = shaping({ hide: ["secret"], fixed: { version: 2 }, rename: { limit: "page_size" } });
    expect(visibleInput(shaped, "limit")).toBe("page_size");
    expect(visibleInput(shaped, "cursor")).toBe("cursor");
    expect(visibleInput(shaped, "secret")).toBeUndefined();
    expect(visibleInput(shaped, "version")).toBeUndefined();
    expect(visibleInput(shaped, undefined)).toBeUndefined();
  });
});

describe("byteLength", () => {
  it("counts UTF-8 bytes", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("é€")).toBe(5);
  });
});

describe("shapeValue", () => {
  it("says so when the upstream returned no content", () => {
    expect(shapeValue(undefined, rules(), ["A note."])).toEqual({
      content: [
        { type: "text", text: "The upstream returned no content." },
        { type: "text", text: "A note." },
      ],
    });
  });

  it("returns an object as structuredContent and its compact JSON", () => {
    const result = shapeValue(CHARGES, rules({ redact: ["url"] }), []);
    const kept = { data: CHARGES.data, has_more: true };
    expect(result).toEqual({ content: [{ type: "text", text: JSON.stringify(kept) }], structuredContent: kept });
  });

  it("returns a list or a scalar as text alone", () => {
    expect(shapeValue([1, 2], rules(), [])).toEqual({ content: [{ type: "text", text: "[1,2]" }] });
    expect(shapeValue(42, rules(), [])).toEqual({ content: [{ type: "text", text: "42" }] });
  });

  it("treats a string that parses as JSON as that JSON", () => {
    const result = shapeValue('{"id":"ch_1","secret":"sk"}', rules({ redact: ["secret"] }), []);
    expect(result).toEqual({ content: [{ type: "text", text: '{"id":"ch_1"}' }], structuredContent: { id: "ch_1" } });
  });

  it("returns other text as it is", () => {
    expect(shapeValue("plain words", rules({ redact: ["words"] }), [])).toEqual({
      content: [{ type: "text", text: "plain words" }],
    });
  });

  it("cuts other text at the cap, with a note", () => {
    expect(shapeValue("abcdefghijklmnop", rules({ max_result_bytes: 10 }), [])).toEqual({
      content: [
        { type: "text", text: "abcdefghij" },
        { type: "text", text: CUT_NOTE(10) },
      ],
    });
  });

  it("never cuts inside a character", () => {
    // a is 1 byte, é is 2, and € is 3.
    expect(texts(shapeValue("aé€x", rules({ max_result_bytes: 5 }), []))[0]).toBe("aé");
    expect(texts(shapeValue("aé€x", rules({ max_result_bytes: 3 }), []))[0]).toBe("aé");
    expect(texts(shapeValue("aé€x", rules({ max_result_bytes: 6 }), []))[0]).toBe("aé€");
    expect(texts(shapeValue("€x", rules({ max_result_bytes: 2 }), []))[0]).toBe("");
  });

  it("keeps the longest head of the list that fits, and says how to get whole pages", () => {
    const value = listOf(10);
    // 26 + 14n bytes of text for n items, and the same again as structuredContent,
    // so 5 items fit in 200 bytes and 6 do not.
    expect(byteLength(JSON.stringify(listOf(5)))).toBe(96);
    expect(byteLength(JSON.stringify(listOf(6)))).toBe(110);
    const result = shapeValue(value, rules({ max_result_bytes: 200 }, CURSOR), ["The paging note."]);
    expect(result.structuredContent).toEqual(listOf(5));
    expect(texts(result)).toEqual([
      JSON.stringify(listOf(5)),
      "The paging note.",
      "The result holds the first 5 of 10 items, cut to fit the 200-byte limit. " +
        "Set limit lower to get whole pages, and page with starting_after.",
    ]);
  });

  it("cuts the list to no items when only that fits", () => {
    // No items take 27 bytes of text and 27 of structuredContent, and one item takes 40 of each.
    const result = shapeValue(listOf(3), rules({ max_result_bytes: 60 }, CURSOR), []);
    expect(result.structuredContent).toEqual(listOf(0));
    expect(texts(result)[1]).toBe(
      "The result holds the first 0 of 3 items, cut to fit the 60-byte limit. " +
        "Set limit lower to get whole pages, and page with starting_after.",
    );
  });

  it("counts structuredContent against the cap, and drops it as the MCP path does", () => {
    const value = { blob: "x".repeat(30) };
    const text = JSON.stringify(value);
    // The text alone fits in 50 bytes, but the text and structuredContent together take 82.
    expect(byteLength(text)).toBe(41);
    const capped = rules({ max_result_bytes: 50 });
    expect(shapeValue(value, capped, [])).toEqual({ content: [{ type: "text", text }] });
    // The MCP path counts the same 82 bytes, drops structuredContent, and keeps the whole text.
    const mcp = shapeToolResult({ content: [{ type: "text", text }], structuredContent: value }, capped, []);
    expect(mcp.structuredContent).toBeUndefined();
    expect(texts(mcp)[0]).toBe(text);
  });

  it("cuts the list until the text and structuredContent together fit", () => {
    // Three items take 68 bytes of text, which fits in 100 bytes alone but not with structuredContent.
    expect(byteLength(JSON.stringify(listOf(3)))).toBe(68);
    const result = shapeValue(listOf(3), rules({ max_result_bytes: 100 }, CURSOR), []);
    expect(result.structuredContent).toEqual(listOf(1));
    expect(texts(result)).toEqual([
      JSON.stringify(listOf(1)),
      "The result holds the first 1 of 3 items, cut to fit the 100-byte limit. " +
        "Set limit lower to get whole pages, and page with starting_after.",
    ]);
    expect(byteLength(JSON.stringify(listOf(1))) + byteLength(JSON.stringify(result.structuredContent))).toBeLessThanOrEqual(100);
  });

  it("cuts the text and drops structuredContent when no list can be cut to fit", () => {
    const value = listOf(3);
    const text = JSON.stringify(value);
    const result = shapeValue(value, rules({ max_result_bytes: 20 }, CURSOR), []);
    expect(result.structuredContent).toBeUndefined();
    expect(texts(result)).toEqual([text.slice(0, 20), CUT_NOTE(20)]);
  });

  it("cuts the text when the value has no list", () => {
    const value = { blob: "x".repeat(200) };
    const result = shapeValue(value, rules({ max_result_bytes: 50 }), []);
    expect(result.structuredContent).toBeUndefined();
    expect(texts(result)).toEqual([JSON.stringify(value).slice(0, 50), CUT_NOTE(50)]);
  });

  it("cuts the text when the list is empty", () => {
    const value = { items: [], blob: "x".repeat(200) };
    const result = shapeValue(value, rules({ max_result_bytes: 50 }), []);
    expect(result.structuredContent).toBeUndefined();
    expect(texts(result)[1]).toBe(CUT_NOTE(50));
  });

  it("measures the size after select and redact", () => {
    const value = { data: [{ id: "ch_1", note: "x".repeat(500) }] };
    const result = shapeValue(value, rules({ max_result_bytes: 100, redact: ["data[].note"] }), []);
    expect(result).toEqual({
      content: [{ type: "text", text: '{"data":[{"id":"ch_1"}]}' }],
      structuredContent: { data: [{ id: "ch_1" }] },
    });
  });
});

describe("shapeToolResult", () => {
  const LEAK = "sk_live_leak";

  it("redacts structuredContent and every JSON text item, so the text cannot leak a redacted field", () => {
    const record = { id: "cus_1", secret: LEAK };
    const image = { type: "image", data: "AAAA", mimeType: "image/png" };
    const result: CallToolResult = {
      content: [{ type: "text", text: JSON.stringify(record) }, image, { type: "text", text: "[1,2]" }],
      structuredContent: record,
    };
    const shaped = shapeToolResult(result, rules({ redact: ["secret"] }), []);
    expect(shaped).toEqual({
      content: [{ type: "text", text: '{"id":"cus_1"}' }, image, { type: "text", text: "[1,2]" }],
      structuredContent: { id: "cus_1" },
    });
    expect(JSON.stringify(shaped)).not.toContain(LEAK);
  });

  it("selects in structuredContent and in JSON text", () => {
    const record = { id: "cus_1", name: "Ada", email: "ada@example.com" };
    const result: CallToolResult = { content: [{ type: "text", text: JSON.stringify(record) }], structuredContent: record };
    expect(shapeToolResult(result, rules({ select: ["id", "name"] }), [])).toEqual({
      content: [{ type: "text", text: '{"id":"cus_1","name":"Ada"}' }],
      structuredContent: { id: "cus_1", name: "Ada" },
    });
  });

  it("leaves text that is not a JSON object alone", () => {
    const result: CallToolResult = { content: [{ type: "text", text: "the secret is plain" }] };
    expect(shapeToolResult(result, rules({ redact: ["secret"] }), [])).toEqual(result);
  });

  it("applies only redact to an error result", () => {
    const result: CallToolResult = {
      content: [{ type: "text", text: JSON.stringify({ error: "Not found", token: LEAK }) }],
      isError: true,
    };
    expect(shapeToolResult(result, rules({ select: ["id"], redact: ["token"] }), [])).toEqual({
      content: [{ type: "text", text: '{"error":"Not found"}' }],
      isError: true,
    });
  });

  it("passes a result through when nothing shapes it, and adds the notes after it", () => {
    const result: CallToolResult = { content: [{ type: "text", text: '{"a":1}' }], structuredContent: { a: 1 } };
    expect(shapeToolResult(result, rules(), ["A note."])).toEqual({
      content: [
        { type: "text", text: '{"a":1}' },
        { type: "text", text: "A note." },
      ],
      structuredContent: { a: 1 },
    });
  });

  it("over the cap, drops structuredContent, keeps what fits, and cuts the first text that does not", () => {
    const result: CallToolResult = {
      content: [
        { type: "text", text: "abcdefgh" },
        { type: "text", text: "ijklmnop" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "text", text: "qrstuvwx" },
      ],
      structuredContent: { a: 1 },
      isError: true,
    };
    expect(shapeToolResult(result, rules({ max_result_bytes: 10 }), ["A note."])).toEqual({
      content: [
        { type: "text", text: "abcdefgh" },
        { type: "text", text: "ij" },
        { type: "text", text: "A note." },
        { type: "text", text: CUT_NOTE(10) },
      ],
      isError: true,
    });
  });

  it("keeps an item that is not text when it fits the cap", () => {
    const image = { type: "image", data: "AA", mimeType: "image/png" };
    const cost = byteLength(JSON.stringify(image));
    const result: CallToolResult = { content: [image, { type: "text", text: "x".repeat(100) }] };
    expect(shapeToolResult(result, rules({ max_result_bytes: cost + 10 }), [])).toEqual({
      content: [image, { type: "text", text: "x".repeat(10) }, { type: "text", text: CUT_NOTE(cost + 10) }],
    });
  });

  it("drops structuredContent when it alone puts the result over the cap", () => {
    const result: CallToolResult = {
      content: [{ type: "text", text: "short" }],
      structuredContent: { blob: "x".repeat(100) },
    };
    expect(shapeToolResult(result, rules({ max_result_bytes: 50 }), [])).toEqual({
      content: [
        { type: "text", text: "short" },
        { type: "text", text: CUT_NOTE(50) },
      ],
    });
  });
});
