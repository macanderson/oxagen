// embeddings.test.ts: a search-mode server's search ranked by a fake
// embedder, with keyword ranking whenever the index fails (lane M15; ADR-217).
import {
  SearchIndex,
  SearchIndexError,
  type CallToolResult,
  type EmbedPurpose,
  type Embedder,
  type SearchIndexStore,
  type StoredVector,
} from "@oxagen/mcp-studio";
import { describe, expect, it } from "vitest";
import { callServed } from "../call";
import { servedRanker, type SearchIndexLookup } from "../embeddings";
import type { Ranker } from "../search";
import type { PublishedTools } from "../types";
import { SOURCES, fakePorts, published, run, server, textOf, view } from "./fixtures";

const REFUND_LINE = "create_refund   Refund a charge to the card it was paid with.   irreversible, high";
const FAILED = "The search index failed, so search ranked by keyword.";

/** SOURCES with billing in search mode. */
function searchBilling(): PublishedTools {
  return published({ servers: SOURCES.map((spec) => server(spec.name === "billing" ? { ...spec, mode: "search" } : spec)) });
}

interface EmbedCall {
  texts: string[];
  purpose: EmbedPurpose;
}

/**
 * A fake model with three axes. It knows that a refund is money given back,
 * which no keyword in the query "give money back" matches.
 */
function fakeEmbedder(): Embedder & { calls: EmbedCall[] } {
  const calls: EmbedCall[] = [];
  const vectorOf = (text: string): Float32Array => {
    const lower = text.toLowerCase();
    return new Float32Array([
      lower.includes("refund") || lower.includes("money back") ? 1 : 0,
      lower.includes("charge") ? 1 : 0,
      lower.includes("list") ? 1 : 0,
    ]);
  };
  return {
    key: "k".repeat(32),
    calls,
    embed(texts, purpose) {
      calls.push({ texts: [...texts], purpose });
      return Promise.resolve(texts.map(vectorOf));
    },
  };
}

function memoryStore(): SearchIndexStore & { rows: Map<string, Float32Array> } {
  const rows = new Map<string, Float32Array>();
  return {
    rows,
    read(key, hashes) {
      const found: StoredVector[] = [];
      for (const hash of hashes) {
        const vector = rows.get(`${key}:${hash}`);
        if (vector !== undefined) found.push({ hash, vector });
      }
      return Promise.resolve(found);
    },
    write(key, written) {
      for (const row of written) rows.set(`${key}:${row.hash}`, row.vector);
      return Promise.resolve();
    },
  };
}

function indexOver(embedder: Embedder): SearchIndex {
  return new SearchIndex({ embedder, store: memoryStore(), namespace: "ws_1" });
}

/** Search billing with the ports' ranker set to rank. */
async function search(rank: Ranker | undefined, args: Record<string, unknown>, given?: Ranker) {
  const { ports, recorded } = fakePorts();
  const withRank = rank === undefined ? ports : { ...ports, rank };
  const v = await view(searchBilling(), withRank, run());
  const result: CallToolResult | null = await callServed(v, withRank, "billing__search", args, given);
  return { result, recorded };
}

describe("servedRanker", () => {
  it("ranks by meaning where no keyword matches", async () => {
    const lookup: SearchIndexLookup<string> = () => Promise.resolve(indexOver(fakeEmbedder()));

    const { result, recorded } = await search(servedRanker("ws_1", lookup), { query: "give money back", limit: 1 });

    expect(textOf(result)).toBe(REFUND_LINE);
    expect(recorded.logs).toEqual([]);
    expect(recorded.meter.map((event) => `${event.kind} ${event.tool} ${event.outcome}`)).toEqual([
      "search billing__search allowed",
    ]);
    const keyword = await search(undefined, { query: "give money back", limit: 1 });
    expect(textOf(keyword.result)).toBe('No billing tool matches "give money back". Search again with other words.');
  });

  it("embeds and ranks only the tools a policy lets the agent see", async () => {
    const embedder = fakeEmbedder();
    const lookup: SearchIndexLookup<string> = () => Promise.resolve(indexOver(embedder));

    const { result } = await search(servedRanker("ws_1", lookup), { query: "remove a customer" });

    const documents = embedder.calls.filter((call) => call.purpose === "document").flatMap((call) => call.texts);
    expect(documents).toEqual([
      "create_refund: Refund a charge to the card it was paid with.",
      "list_charges: List the charges on the account.",
    ]);
    expect(textOf(result)).not.toContain("delete_customer");
    expect(textOf(result).split("\n")).toHaveLength(2);
  });

  it("looks up the index for the scope it was given", async () => {
    const scopes: string[] = [];
    const lookup: SearchIndexLookup<string> = (scope) => {
      scopes.push(scope);
      return Promise.resolve(null);
    };

    await search(servedRanker("ws_1", lookup), { query: "refund" });

    expect(scopes).toEqual(["ws_1"]);
  });

  it("ranks by keyword when the workspace ranks by keyword", async () => {
    const { result, recorded } = await search(servedRanker("ws_1", () => Promise.resolve(null)), { query: "refund" });

    expect(textOf(result)).toBe(REFUND_LINE);
    expect(recorded.logs).toEqual([]);
  });

  it("falls back to keyword ranking and logs the code when the endpoint fails", async () => {
    const failing: Embedder = {
      key: "k".repeat(32),
      embed: () => Promise.reject(new SearchIndexError("unreachable", "The embeddings endpoint answered HTTP 503.", 503)),
    };
    const lookup: SearchIndexLookup<string> = () => Promise.resolve(indexOver(failing));

    const { result, recorded } = await search(servedRanker("ws_1", lookup), { query: "refund" });

    expect(result?.isError).not.toBe(true);
    expect(textOf(result)).toBe(REFUND_LINE);
    expect(recorded.logs).toEqual([{ message: FAILED, fields: { server: "billing", error: "SearchIndexError", code: "unreachable" } }]);
  });

  it("falls back to keyword ranking when the key is missing", async () => {
    const lookup: SearchIndexLookup<string> = () =>
      Promise.reject(new SearchIndexError("no_key", "VOYAGE_API_KEY is not set, so search ranks by keyword."));

    const { result, recorded } = await search(servedRanker("ws_1", lookup), { query: "refund" });

    expect(textOf(result)).toBe(REFUND_LINE);
    expect(recorded.logs).toEqual([{ message: FAILED, fields: { server: "billing", error: "SearchIndexError", code: "no_key" } }]);
  });

  it("prefers the ranker a caller passes over the ports' ranker", async () => {
    const unused: Ranker = () => Promise.reject(new Error("The ports' ranker ran."));
    const first: Ranker = (_query, entries) => Promise.resolve(entries.slice(0, 1));

    const { result, recorded } = await search(unused, { query: "anything" }, first);

    expect(textOf(result).split("   ")[0]).toBe("create_refund");
    expect(recorded.logs).toEqual([]);
  });
});
