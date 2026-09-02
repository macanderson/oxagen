import { tavily } from "@tavily/core";

export interface SearchResult {
  /** Page title as Tavily reported it. Empty string when Tavily omitted it. */
  title: string;
  /**
   * Result URL. Empty string when Tavily omitted it — note that an empty
   * string fails the `search_web` contract's `z.string().url()` output check,
   * which fails the whole call rather than the one result.
   */
  url: string;
  /** Snippet of matched page text. Untrusted — it is third-party page content. */
  content: string;
  /** Tavily's relevance score. Higher is more relevant. */
  score: number;
  /** Publication date as Tavily reported it; absent when unknown. */
  publishedDate?: string;
}

export interface SearchOptions {
  /** Free-text search query. */
  query: string;
  /** Upper bound on returned results. Tavily may return fewer. */
  maxResults: number;
  /** "basic" is faster; "advanced" reads more deeply and costs more. */
  searchDepth: "basic" | "advanced";
  /** When set, restrict results to these domains. */
  includeDomains?: string[];
  /** When set, drop results from these domains. */
  excludeDomains?: string[];
}

export interface SearchResponse {
  results: SearchResult[];
  /**
   * How many results this call returned — never more than `maxResults`.
   * This is not a count of matches available upstream; Tavily does not
   * report one.
   */
  totalResults: number;
  /**
   * A local correlation id, minted here from the clock. Tavily does not
   * issue a request id, so this value cannot be quoted back to them and is
   * not guaranteed unique across concurrent calls in the same millisecond.
   */
  searchId: string;
}

/**
 * Perform a web search using the Tavily API.
 *
 * Throws if TAVILY_API_KEY is not set in the environment.
 *
 * No timeout is passed and there is no abort signal, so this call is bounded
 * only by the Tavily SDK's own default of 60 seconds — six times the 10s the
 * `fetch_web_page` contract allows, and there is no way for a caller to
 * shorten it. The SDK does accept a per-call `timeout`; nothing here sets it.
 */
export async function webSearch(
  options: SearchOptions,
): Promise<SearchResponse> {
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
