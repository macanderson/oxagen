// search.ts: a search-mode server's search tool (lane M15; steering spec,
// Finding tools).
//
// search takes a query and a limit of up to 10, and returns one line per
// served tool: the name after the prefix, the first sentence of the
// description, and the side effect and risk. This file ranks by keyword.
// embeddings.ts ranks by the workspace's embeddings in front of it, and
// search falls back to this file's ranking when that fails (ADR-217).
import { firstSentence, shortName, type ManifestServer } from "@oxagen/mcp-studio";
import type { ServedTool } from "./snapshot";

// Publish embeds the same line, so both sides take it from @oxagen/mcp-studio.
export { firstSentence };

/** The most lines one search returns. */
export const SEARCH_LIMIT = 10;

/** One served tool as search ranks it. */
export interface SearchEntry {
  /** The name after the prefix: create_refund. */
  short: string;
  /** The full name: billing__create_refund. */
  name: string;
  /** The first sentence of the description. */
  summary: string;
  side_effect: string;
  risk: string;
}

/** Rank the entries for a query and return at most limit of them. */
export type Ranker = (query: string, entries: readonly SearchEntry[], limit: number) => Promise<readonly SearchEntry[]>;

export function searchEntry(server: ManifestServer, { tool }: ServedTool): SearchEntry {
  return {
    short: shortName(server, tool),
    name: tool.name,
    summary: firstSentence(tool.definition.description),
    side_effect: tool.classification.side_effect,
    risk: tool.classification.risk,
  };
}

/** Lowercase words, with a trailing plural s dropped so refund matches refunds. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
}

function score(query: readonly string[], entry: SearchEntry): number {
  const name = words(entry.short);
  const summary = words(entry.summary);
  let total = 0;
  for (const word of query) {
    if (name.includes(word)) total += 3;
    else if (name.some((part) => part.startsWith(word))) total += 0.5;
    if (summary.includes(word)) total += 1;
    else if (summary.some((part) => part.startsWith(word))) total += 0.5;
  }
  return total;
}

/** Rank by the query's words in the name, then in the summary. A tool that matches no word is left out. */
export const keywordRank: Ranker = (query, entries, limit) => {
  const wanted = words(query);
  const scored = entries
    .map((entry) => ({ entry, score: score(wanted, entry) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || (a.entry.short < b.entry.short ? -1 : a.entry.short > b.entry.short ? 1 : 0));
  return Promise.resolve(scored.slice(0, limit).map((row) => row.entry));
};

/** The lines search returns, padded into three columns. */
export function searchLines(entries: readonly SearchEntry[]): string {
  const nameWidth = Math.max(...entries.map((entry) => entry.short.length));
  const summaryWidth = Math.max(...entries.map((entry) => entry.summary.length));
  return entries
    .map((entry) =>
      [entry.short.padEnd(nameWidth), entry.summary.padEnd(summaryWidth), `${entry.side_effect}, ${entry.risk}`].join("   "),
    )
    .join("\n");
}

export type SearchArguments = { ok: true; query: string; limit: number } | { ok: false; message: string };

/** Read search's arguments: a query, and a limit from 1 to 10 that defaults to 10. */
export function searchArguments(args: Record<string, unknown>): SearchArguments {
  const query = args["query"];
  if (typeof query !== "string" || query.trim() === "") {
    return { ok: false, message: "search needs a query. Pass the words to look for in query." };
  }
  const limit = args["limit"] ?? SEARCH_LIMIT;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > SEARCH_LIMIT) {
    return { ok: false, message: `limit is a whole number from 1 to ${SEARCH_LIMIT}. Pass a smaller limit, or leave it out.` };
  }
  return { ok: true, query: query.trim(), limit };
}
