import { describe, expect, it, vi } from "vitest";
import { SearchIndexError, type Embedder } from "./embedder";
import { contentHash } from "./entry";
import { SearchIndex, VectorCache, cosine, type RankOptions } from "./search-index";
import { axes, fakeEmbedder, memoryStore } from "./__tests__/fakes";

interface Entry {
  short: string;
  summary: string;
}

const ENTRIES: Entry[] = [
  { short: "list_charges", summary: "List the charges on an account." },
  { short: "create_refund", summary: "Give money back for a charge." },
  { short: "send_invoice", summary: "Email an invoice to a customer." },
  { short: "void_invoice", summary: "Cancel an invoice." },
];

const OPTIONS: RankOptions<Entry> = {
  text: (entry) => `${entry.short}: ${entry.summary}`,
  name: (entry) => entry.short,
  limit: 10,
};

// The fake model knows that a refund is money given back.
const vectorOf = (text: string): number[] => {
  const words = axes(["money back", "charge", "invoice", "customer"])(text);
  if (text.includes("refund")) words[0] = 1;
  return words;
};

function index(embedder: Embedder = fakeEmbedder(vectorOf), store = memoryStore(), cache = new VectorCache()): SearchIndex {
  return new SearchIndex({ embedder, store, cache, namespace: "ws-1" });
}

describe("SearchIndex.rank", () => {
  it("ranks the entries most like the query first", async () => {
    const ranked = await index().rank("refund a charge", ENTRIES, OPTIONS);

    expect(ranked.map((entry) => entry.short)).toEqual(["create_refund", "list_charges", "send_invoice", "void_invoice"]);
  });

  it("finds a tool by meaning when no word matches its name", async () => {
    const ranked = await index().rank("give the money back", ENTRIES, { ...OPTIONS, limit: 1 });

    expect(ranked.map((entry) => entry.short)).toEqual(["create_refund"]);
  });

  it("breaks a tie by name and stops at the limit", async () => {
    const ranked = await index().rank("invoice", ENTRIES, { ...OPTIONS, limit: 2 });

    expect(ranked.map((entry) => entry.short)).toEqual(["void_invoice", "send_invoice"]);
    const tie = await index().rank("invoice", ENTRIES.slice(2).map((entry) => ({ ...entry, summary: "An invoice." })), OPTIONS);
    expect(tie.map((entry) => entry.short)).toEqual(["send_invoice", "void_invoice"]);
  });

  it("ranks only the entries it is given, so a hidden tool never appears", async () => {
    const visible = ENTRIES.filter((entry) => entry.short !== "create_refund");

    const ranked = await index().rank("refund a charge", visible, OPTIONS);

    expect(ranked.map((entry) => entry.short)).not.toContain("create_refund");
    expect(ranked).toHaveLength(3);
  });

  it("asks for nothing when there is nothing to rank", async () => {
    const embedder = fakeEmbedder(vectorOf);
    const search = index(embedder);

    expect(await search.rank("refund", [], OPTIONS)).toEqual([]);
    expect(await search.rank("refund", ENTRIES, { ...OPTIONS, limit: 0 })).toEqual([]);
    expect(embedder.calls).toHaveLength(0);
  });

  it("embeds entries as documents and the query as a query, once each", async () => {
    const embedder = fakeEmbedder(vectorOf);
    const search = index(embedder);

    await search.rank("refund", ENTRIES, OPTIONS);
    await search.rank("refund", ENTRIES, OPTIONS);

    const calls = embedder.calls.map((call) => [call.purpose, call.texts.length]);
    expect(calls).toHaveLength(2);
    expect(calls).toEqual(expect.arrayContaining([["document", 4], ["query", 1]]));
  });

  it("reads stored vectors before it embeds", async () => {
    const store = memoryStore();
    await index(fakeEmbedder(vectorOf), store).warm(ENTRIES.map(OPTIONS.text));
    const embedder = fakeEmbedder(vectorOf);

    const ranked = await index(embedder, store, new VectorCache()).rank("refund", ENTRIES, { ...OPTIONS, limit: 1 });

    expect(ranked.map((entry) => entry.short)).toEqual(["create_refund"]);
    expect(embedder.calls.map((call) => call.purpose)).toEqual(["query"]);
  });

  it("fails when a stored vector and the query's differ in length", async () => {
    const store = memoryStore();
    await index(fakeEmbedder(() => [1, 0]), store).warm(ENTRIES.map(OPTIONS.text));
    const wider = fakeEmbedder(() => [1, 0, 0]);

    const error = await index(wider, store).rank("refund", ENTRIES, OPTIONS).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SearchIndexError);
    expect(error).toMatchObject({ code: "incomplete" });
  });

  it("passes an embedder failure to the caller", async () => {
    const failing: Embedder = {
      key: "k".repeat(32),
      embed: () => Promise.reject(new SearchIndexError("unreachable", "The endpoint failed.")),
    };

    await expect(index(failing).rank("refund", ENTRIES, OPTIONS)).rejects.toMatchObject({ code: "unreachable" });
  });

  it("passes a store read failure to the caller", async () => {
    const store = memoryStore();
    store.read = () => Promise.reject(new Error("connection lost"));

    await expect(index(fakeEmbedder(vectorOf), store).rank("refund", ENTRIES, OPTIONS)).rejects.toThrow("connection lost");
  });

  it("times out, and keeps embedding for the next search", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const embedder = fakeEmbedder(async (text) => {
      await gate;
      return vectorOf(text);
    });
    const store = memoryStore();
    const search = new SearchIndex({ embedder, store, namespace: "ws-1", rankTimeoutMs: 5 });

    await expect(search.rank("refund", ENTRIES, OPTIONS)).rejects.toMatchObject({ code: "timeout" });
    release?.();
    await vi.waitFor(() => expect(store.rows.size).toBe(ENTRIES.length));
  });

  it("fails when the endpoint returns no vector for the query", async () => {
    const empty: Embedder = {
      key: "k".repeat(32),
      embed: (texts, purpose) => Promise.resolve(purpose === "query" ? [] : texts.map(() => new Float32Array([1]))),
    };

    await expect(index(empty).rank("refund", ENTRIES, OPTIONS)).rejects.toMatchObject({ code: "incomplete" });
  });

  it("fails when the endpoint returns too few document vectors", async () => {
    const short: Embedder = {
      key: "k".repeat(32),
      embed: () => Promise.resolve([new Float32Array([1])]),
    };
    const store = memoryStore();

    await expect(index(short, store).rank("refund", ENTRIES, OPTIONS)).rejects.toMatchObject({ code: "incomplete" });
    expect(store.writes[0]?.rows).toHaveLength(1);
  });
});

describe("SearchIndex.vectors", () => {
  it("embeds a line once for callers that ask at the same time", async () => {
    const embedder = fakeEmbedder(async (text) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return vectorOf(text);
    });
    const search = index(embedder);
    const texts = ENTRIES.map(OPTIONS.text);

    const [first, second] = await Promise.all([search.vectors(texts), search.vectors([...texts, texts[0] ?? ""])]);

    expect(embedder.calls).toHaveLength(1);
    expect(first.size).toBe(4);
    expect(second.get(contentHash(texts[0] ?? ""))).toEqual(first.get(contentHash(texts[0] ?? "")));
  });

  it("fails every caller waiting on a failed line", async () => {
    const embedder: Embedder = {
      key: "k".repeat(32),
      embed: () => new Promise((_, reject) => setTimeout(() => reject(new SearchIndexError("timeout", "Too slow.")), 1)),
    };
    const search = index(embedder);

    const results = await Promise.allSettled([search.vectors(["a"]), search.vectors(["a"])]);

    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  });

  it("still returns vectors when the store write fails, and logs only the error's name", async () => {
    const store = memoryStore();
    store.write = () => Promise.reject(new Error("password=hunter2"));
    const log = vi.fn();
    const search = new SearchIndex({ embedder: fakeEmbedder(vectorOf), store, namespace: "ws-1", log });

    const found = await search.vectors(["list_charges"]);

    expect(found.size).toBe(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("could not store"), { errorName: "Error", count: 1 });
    expect(JSON.stringify(log.mock.calls)).not.toContain("hunter2");
  });

  it("logs a thrown value that is not an Error by its type", async () => {
    const store = memoryStore();
    store.write = () => Promise.reject("plain");
    const log = vi.fn();

    await new SearchIndex({ embedder: fakeEmbedder(vectorOf), store, namespace: "ws-1", log }).vectors(["a"]);

    expect(log).toHaveBeenCalledWith(expect.any(String), { errorName: "string", count: 1 });
  });
});

describe("SearchIndex.warm", () => {
  it("embeds and stores new lines under the target key, and skips stored ones", async () => {
    const store = memoryStore();
    const search = index(fakeEmbedder(vectorOf, "a".repeat(32)), store);
    const texts = ENTRIES.map(OPTIONS.text);

    expect(await search.warm(texts)).toBe(4);
    expect(await search.warm(texts)).toBe(0);
    expect(await index(fakeEmbedder(vectorOf, "a".repeat(32)), store).warm(texts)).toBe(0);
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]?.key).toBe("a".repeat(32));
    expect(search.key).toBe("a".repeat(32));
  });

  it("embeds every line again when the target key changes", async () => {
    const store = memoryStore();
    const texts = ENTRIES.map(OPTIONS.text);
    await index(fakeEmbedder(vectorOf, "a".repeat(32)), store).warm(texts);

    const moved = fakeEmbedder(vectorOf, "b".repeat(32));
    expect(await index(moved, store).warm(texts)).toBe(4);

    expect(store.reads.at(-1)?.key).toBe("b".repeat(32));
    expect(store.rows.size).toBe(8);
  });

  it("keeps one workspace's cached vectors apart from another's", async () => {
    const cache = new VectorCache();
    const store = memoryStore();
    await new SearchIndex({ embedder: fakeEmbedder(vectorOf), store, cache, namespace: "ws-1" }).warm(["a"]);

    await new SearchIndex({ embedder: fakeEmbedder(vectorOf), store, cache, namespace: "ws-2" }).warm(["a"]);

    expect(store.reads).toHaveLength(2);
  });
});

describe("VectorCache", () => {
  it("drops the least recently used vector past its capacity", () => {
    const cache = new VectorCache(2);
    cache.set("a", new Float32Array([1]));
    cache.set("b", new Float32Array([2]));
    cache.get("a");
    cache.set("c", new Float32Array([3]));

    expect(cache.size).toBe(2);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toEqual(new Float32Array([1]));
    expect(cache.get("c")).toEqual(new Float32Array([3]));
  });

  it("keeps nothing at capacity zero", () => {
    const cache = new VectorCache(0);
    cache.set("a", new Float32Array([1]));
    expect(cache.size).toBe(0);
  });
});

describe("cosine", () => {
  it("is 1 for one direction, 0 for a zero vector, and refuses unequal lengths", () => {
    expect(cosine(new Float32Array([1, 1]), new Float32Array([2, 2]))).toBeCloseTo(1);
    expect(cosine(new Float32Array([0, 0]), new Float32Array([1, 0]))).toBe(0);
    expect(() => cosine(new Float32Array([1]), new Float32Array([1, 0]))).toThrow(SearchIndexError);
  });
});
