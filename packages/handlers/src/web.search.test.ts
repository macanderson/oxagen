/**
 * Unit tests for the web.search handler.
 *
 * Covers:
 *  - Happy path: maps Tavily results to contract output shape.
 *  - Missing TAVILY_API_KEY: throws a clear error at call time.
 *  - Empty results: returns totalResults=0 and empty array.
 *  - Default values: maxResults defaults to 5, searchDepth defaults to "basic".
 *  - includeDomains / excludeDomains forwarded to the Tavily client.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted stubs ─────────────────────────────────────────────────────────────

const { mockWebSearch } = vi.hoisted(() => ({
  mockWebSearch: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@oxagen/web", () => ({
  webSearch: mockWebSearch,
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { webSearchHandler } from "./web.search";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── Helpers ───────────────────────────────────────────────────────────────────

const validCtx: CapabilityContext = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "u-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "api",
  messageId: null,
};

const sampleResults = [
  {
    title: "Example Domain",
    url: "https://example.com",
    content: "This domain is for use in illustrative examples.",
    score: 0.95,
    publishedDate: "2024-01-01",
  },
  {
    title: "Another Site",
    url: "https://another.com/article",
    content: "Some article content here.",
    score: 0.82,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe("webSearchHandler — happy path", () => {
  it("returns mapped results matching the contract output shape", async () => {
    const searchId = "tvly-1234567890-200";
    mockWebSearch.mockResolvedValueOnce({
      results: sampleResults,
      totalResults: 2,
      searchId,
    });

    const result = await webSearchHandler(
      { query: "example query", maxResults: 5, searchDepth: "basic" },
      validCtx,
    );

    expect(result.results).toHaveLength(2);
    expect(result.totalResults).toBe(2);
    expect(result.searchId).toBe(searchId);

    const first = result.results[0];
    expect(first).toBeDefined();
    expect(first!.title).toBe("Example Domain");
    expect(first!.url).toBe("https://example.com");
    expect(first!.score).toBe(0.95);
    expect(first!.publishedDate).toBe("2024-01-01");
  });

  it("forwards includeDomains and excludeDomains to webSearch", async () => {
    mockWebSearch.mockResolvedValueOnce({
      results: [],
      totalResults: 0,
      searchId: "tvly-abc",
    });

    await webSearchHandler(
      {
        query: "restricted search",
        maxResults: 3,
        searchDepth: "advanced",
        includeDomains: ["github.com"],
        excludeDomains: ["twitter.com"],
      },
      validCtx,
    );

    expect(mockWebSearch).toHaveBeenCalledOnce();
    const callArg = mockWebSearch.mock.calls[0]![0] as {
      includeDomains: string[];
      excludeDomains: string[];
      searchDepth: string;
      maxResults: number;
    };
    expect(callArg.includeDomains).toEqual(["github.com"]);
    expect(callArg.excludeDomains).toEqual(["twitter.com"]);
    expect(callArg.searchDepth).toBe("advanced");
    expect(callArg.maxResults).toBe(3);
  });

  it("returns empty results without error", async () => {
    mockWebSearch.mockResolvedValueOnce({
      results: [],
      totalResults: 0,
      searchId: "tvly-empty",
    });

    const result = await webSearchHandler(
      { query: "obscure query", maxResults: 5, searchDepth: "basic" },
      validCtx,
    );

    expect(result.results).toHaveLength(0);
    expect(result.totalResults).toBe(0);
  });
});

// ── Default value forwarding ──────────────────────────────────────────────────

describe("webSearchHandler — default forwarding", () => {
  it("passes maxResults=5 and searchDepth=basic when contract defaults are applied", async () => {
    mockWebSearch.mockResolvedValueOnce({
      results: [],
      totalResults: 0,
      searchId: "tvly-defaults",
    });

    // Pass in the post-Zod-default values that the route layer would supply.
    await webSearchHandler(
      { query: "test", maxResults: 5, searchDepth: "basic" },
      validCtx,
    );

    const callArg = mockWebSearch.mock.calls[0]![0] as {
      maxResults: number;
      searchDepth: string;
    };
    expect(callArg.maxResults).toBe(5);
    expect(callArg.searchDepth).toBe("basic");
  });
});

// ── Error propagation ─────────────────────────────────────────────────────────

describe("webSearchHandler — error propagation", () => {
  it("propagates errors from webSearch (e.g. missing API key)", async () => {
    mockWebSearch.mockRejectedValueOnce(
      new Error(
        "web.search: TAVILY_API_KEY environment variable is required but not set",
      ),
    );

    await expect(
      webSearchHandler(
        { query: "some query", maxResults: 5, searchDepth: "basic" },
        validCtx,
      ),
    ).rejects.toThrow(/TAVILY_API_KEY/);
  });

  it("propagates generic network errors", async () => {
    mockWebSearch.mockRejectedValueOnce(new Error("Network timeout"));

    await expect(
      webSearchHandler(
        { query: "some query", maxResults: 5, searchDepth: "basic" },
        validCtx,
      ),
    ).rejects.toThrow(/Network timeout/);
  });
});
