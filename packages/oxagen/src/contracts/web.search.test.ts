import { describe, expect, it } from "vitest";
import { webSearch } from "./web.search";
import { getCapability } from "../registry";

describe("web.search capability", () => {
  // ── input: defaults ───────────────────────────────────────────────────────

  it("defaults maxResults to 5", () => {
    const parsed = webSearch.input.parse({ query: "hello world" });
    expect(parsed.maxResults).toBe(5);
  });

  it("defaults searchDepth to 'basic'", () => {
    const parsed = webSearch.input.parse({ query: "hello world" });
    expect(parsed.searchDepth).toBe("basic");
  });

  it("optional domain lists are undefined when omitted", () => {
    const parsed = webSearch.input.parse({ query: "hello world" });
    expect(parsed.includeDomains).toBeUndefined();
    expect(parsed.excludeDomains).toBeUndefined();
  });

  // ── input: query validation ───────────────────────────────────────────────

  it("rejects an empty query (min 1)", () => {
    expect(() => webSearch.input.parse({ query: "" })).toThrow();
  });

  it("rejects a query exceeding 500 chars", () => {
    expect(() => webSearch.input.parse({ query: "q".repeat(501) })).toThrow();
  });

  it("accepts a query at exactly 500 chars (max boundary)", () => {
    const query = "q".repeat(500);
    const parsed = webSearch.input.parse({ query });
    expect(parsed.query).toBe(query);
  });

  it("rejects missing query", () => {
    expect(() => webSearch.input.parse({})).toThrow();
  });

  // ── input: maxResults bounds ──────────────────────────────────────────────

  it("accepts maxResults=1 (min)", () => {
    const parsed = webSearch.input.parse({ query: "test", maxResults: 1 });
    expect(parsed.maxResults).toBe(1);
  });

  it("accepts maxResults=10 (max)", () => {
    const parsed = webSearch.input.parse({ query: "test", maxResults: 10 });
    expect(parsed.maxResults).toBe(10);
  });

  it("rejects maxResults=0 (below min)", () => {
    expect(() =>
      webSearch.input.parse({ query: "test", maxResults: 0 }),
    ).toThrow();
  });

  it("rejects maxResults=11 (above max)", () => {
    expect(() =>
      webSearch.input.parse({ query: "test", maxResults: 11 }),
    ).toThrow();
  });

  it("rejects non-integer maxResults", () => {
    expect(() =>
      webSearch.input.parse({ query: "test", maxResults: 3.5 }),
    ).toThrow();
  });

  // ── input: searchDepth enum ───────────────────────────────────────────────

  it("accepts searchDepth='advanced'", () => {
    const parsed = webSearch.input.parse({
      query: "test",
      searchDepth: "advanced",
    });
    expect(parsed.searchDepth).toBe("advanced");
  });

  it("rejects unknown searchDepth value", () => {
    expect(() =>
      webSearch.input.parse({ query: "test", searchDepth: "turbo" }),
    ).toThrow();
  });

  // ── input: optional domain arrays ────────────────────────────────────────

  it("accepts includeDomains array", () => {
    const parsed = webSearch.input.parse({
      query: "test",
      includeDomains: ["example.com", "docs.example.com"],
    });
    expect(parsed.includeDomains).toEqual(["example.com", "docs.example.com"]);
  });

  it("accepts excludeDomains array", () => {
    const parsed = webSearch.input.parse({
      query: "test",
      excludeDomains: ["spam.com"],
    });
    expect(parsed.excludeDomains).toEqual(["spam.com"]);
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output with one result", () => {
    const parsed = webSearch.output.parse({
      results: [
        {
          title: "Example",
          url: "https://example.com",
          content: "This is an example page.",
          score: 0.95,
          publishedDate: "2024-01-15",
        },
      ],
      totalResults: 1,
      searchId: "srch-001",
    });
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0]?.title).toBe("Example");
    expect(parsed.results[0]?.score).toBe(0.95);
    expect(parsed.totalResults).toBe(1);
    expect(parsed.searchId).toBe("srch-001");
  });

  it("parses a result without publishedDate (optional)", () => {
    const parsed = webSearch.output.parse({
      results: [
        {
          title: "No Date",
          url: "https://nodateexample.com",
          content: "Content here.",
          score: 0.7,
        },
      ],
      totalResults: 1,
      searchId: "srch-002",
    });
    expect(parsed.results[0]?.publishedDate).toBeUndefined();
  });

  it("parses empty results array", () => {
    const parsed = webSearch.output.parse({
      results: [],
      totalResults: 0,
      searchId: "srch-003",
    });
    expect(parsed.results).toHaveLength(0);
    expect(parsed.totalResults).toBe(0);
  });

  it("rejects a result with non-URL url", () => {
    expect(() =>
      webSearch.output.parse({
        results: [
          {
            title: "Bad URL",
            url: "not-a-url",
            content: "Content.",
            score: 0.5,
          },
        ],
        totalResults: 1,
        searchId: "srch-004",
      }),
    ).toThrow();
  });

  it("rejects output with negative totalResults", () => {
    expect(() =>
      webSearch.output.parse({
        results: [],
        totalResults: -1,
        searchId: "srch-005",
      }),
    ).toThrow();
  });

  it("rejects output missing searchId", () => {
    expect(() =>
      webSearch.output.parse({
        results: [],
        totalResults: 0,
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("search_web")).toBe(webSearch);
  });
});
