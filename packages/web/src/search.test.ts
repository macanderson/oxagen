import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tavily } from "@tavily/core";
import { webSearch } from "./search";

vi.mock("@tavily/core", () => ({
  tavily: vi.fn(),
}));

const tavilyMock = vi.mocked(tavily);

type TavilyClient = ReturnType<typeof tavily>;

/** Install a Tavily client whose `search` resolves to `response`. */
function mockClient(response: unknown) {
  const search = vi.fn().mockResolvedValue(response);
  tavilyMock.mockReturnValue({ search } as unknown as TavilyClient);
  return search;
}

const BASE_OPTIONS = {
  query: "oxagen capability kernel",
  maxResults: 5,
  searchDepth: "basic" as const,
};

describe("webSearch", () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env["TAVILY_API_KEY"];
    process.env["TAVILY_API_KEY"] = "tvly-test-key";
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env["TAVILY_API_KEY"];
    } else {
      process.env["TAVILY_API_KEY"] = originalKey;
    }
  });

  it("throws a named error when TAVILY_API_KEY is missing", async () => {
    delete process.env["TAVILY_API_KEY"];
    await expect(webSearch(BASE_OPTIONS)).rejects.toThrow(
      "TAVILY_API_KEY environment variable is required but not set",
    );
  });

  it("treats an empty TAVILY_API_KEY as missing", async () => {
    process.env["TAVILY_API_KEY"] = "";
    await expect(webSearch(BASE_OPTIONS)).rejects.toThrow("TAVILY_API_KEY");
  });

  it("passes every caller option through to the Tavily client", async () => {
    const search = mockClient({ results: [] });

    await webSearch({
      ...BASE_OPTIONS,
      maxResults: 3,
      searchDepth: "advanced",
      includeDomains: ["oxagen.sh"],
      excludeDomains: ["spam.example"],
    });

    expect(tavilyMock).toHaveBeenCalledWith({ apiKey: "tvly-test-key" });
    expect(search).toHaveBeenCalledWith("oxagen capability kernel", {
      maxResults: 3,
      searchDepth: "advanced",
      includeDomains: ["oxagen.sh"],
      excludeDomains: ["spam.example"],
    });
  });

  it("maps results and reports how many were returned", async () => {
    mockClient({
      results: [
        {
          title: "First",
          url: "https://example.com/1",
          content: "snippet one",
          score: 0.9,
          publishedDate: "2026-01-01",
        },
        {
          title: "Second",
          url: "https://example.com/2",
          content: "snippet two",
          score: 0.4,
        },
      ],
    });

    const result = await webSearch(BASE_OPTIONS);

    expect(result.totalResults).toBe(2);
    expect(result.results[0]).toEqual({
      title: "First",
      url: "https://example.com/1",
      content: "snippet one",
      score: 0.9,
      publishedDate: "2026-01-01",
    });
    expect(result.results[1]?.publishedDate).toBeUndefined();
  });

  it("defaults every missing result field rather than emitting undefined", async () => {
    mockClient({ results: [{}] });

    const result = await webSearch(BASE_OPTIONS);

    expect(result.results[0]).toEqual({
      title: "",
      url: "",
      content: "",
      score: 0,
      publishedDate: undefined,
    });
  });

  it("treats a response with no results array as an empty result set", async () => {
    mockClient({});

    const result = await webSearch(BASE_OPTIONS);

    expect(result.results).toEqual([]);
    expect(result.totalResults).toBe(0);
  });

  it("mints a searchId locally, with and without a responseTime", async () => {
    mockClient({ results: [], responseTime: 1.23 });
    const withTime = await webSearch(BASE_OPTIONS);
    expect(withTime.searchId).toMatch(/^tvly-\d+-1\.23$/);

    mockClient({ results: [] });
    const withoutTime = await webSearch(BASE_OPTIONS);
    expect(withoutTime.searchId).toMatch(/^tvly-\d+$/);
  });

  it("propagates Tavily transport errors to the caller", async () => {
    const search = vi.fn().mockRejectedValue(new Error("tavily: 429"));
    tavilyMock.mockReturnValue({ search } as unknown as TavilyClient);

    await expect(webSearch(BASE_OPTIONS)).rejects.toThrow("tavily: 429");
  });
});
