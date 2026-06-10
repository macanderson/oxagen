import { tavily } from "@tavily/core";

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  publishedDate?: string;
}

export interface SearchOptions {
  query: string;
  maxResults: number;
  searchDepth: "basic" | "advanced";
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface SearchResponse {
  results: SearchResult[];
  totalResults: number;
  searchId: string;
}

/**
 * Perform a web search using the Tavily API.
 *
 * Throws if TAVILY_API_KEY is not set in the environment.
 */
export async function webSearch(options: SearchOptions): Promise<SearchResponse> {
  const apiKey = process.env["TAVILY_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "web.search: TAVILY_API_KEY environment variable is required but not set",
    );
  }

  const client = tavily({ apiKey });

  const response = await client.search(options.query, {
    maxResults: options.maxResults,
    searchDepth: options.searchDepth,
    includeDomains: options.includeDomains,
    excludeDomains: options.excludeDomains,
  });

  const results: SearchResult[] = (response.results ?? []).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    content: r.content ?? "",
    score: r.score ?? 0,
    publishedDate: r.publishedDate ?? undefined,
  }));

  return {
    results,
    totalResults: results.length,
    searchId: response.responseTime
      ? `tvly-${Date.now()}-${response.responseTime}`
      : `tvly-${Date.now()}`,
  };
}
