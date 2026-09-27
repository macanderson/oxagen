import { describe, expect, it, vi } from "vitest";
import {
  compareText,
  gitBlobId,
  TreeReader,
  treeFromFiles,
  type SteeringTree,
  type TreeEntry,
} from "./tree";

// Blob ids from `git hash-object --stdin` over the same bytes.
const HELLO = "hello\n";
const HELLO_BLOB = "ce013625030ba8dba906f756967f9e9ca394464a";
const BETA = "beta\n";
const BETA_BLOB = "65b2df87f7df3aeedef04be96703e55ac19c2cfb";
const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
const E_ACUTE_BLOB = "c6003325155f475bd7c87731607525dce73be9cf";

/** A host tree that lists `entries` exactly as given, with a spy on its reads. */
function hostTree(entries: readonly TreeEntry[], files: ReadonlyMap<string, string>) {
  const read = vi.fn<SteeringTree["read"]>(async (path) => {
    const text = files.get(path);
    if (text === undefined) throw new Error(`${path} is not in the tree.`);
    return text;
  });
  const tree: SteeringTree = { list: async () => entries, read };
  return { tree, read };
}

// ── gitBlobId ────────────────────────────────────────────────────────────────

describe("gitBlobId", () => {
  it("matches git hash-object for a text file", () => {
    expect(gitBlobId(HELLO)).toBe(HELLO_BLOB);
  });

  it("matches git hash-object for an empty file", () => {
    expect(gitBlobId("")).toBe(EMPTY_BLOB);
  });

  it("counts UTF-8 bytes, not UTF-16 code units, in the header", () => {
    // Two code units, three bytes.
    expect(gitBlobId("é\n")).toBe(E_ACUTE_BLOB);
  });
});

// ── treeFromFiles ────────────────────────────────────────────────────────────

describe("treeFromFiles", () => {
  it("lists every path with its blob id in the map's order", async () => {
    const tree = treeFromFiles(
      new Map([
        ["b.md", BETA],
        ["a.md", HELLO],
      ]),
    );

    expect(await tree.list()).toEqual([
      { path: "b.md", blob: BETA_BLOB },
      { path: "a.md", blob: HELLO_BLOB },
    ]);
  });

  it("reads a file's text", async () => {
    const tree = treeFromFiles(new Map([["a.md", HELLO]]));

    expect(await tree.read("a.md")).toBe(HELLO);
  });

  it("rejects a path it does not hold", async () => {
    const tree = treeFromFiles(new Map([["a.md", HELLO]]));

    await expect(tree.read("missing.md")).rejects.toThrow("missing.md is not in the tree.");
  });
});

// ── TreeReader ───────────────────────────────────────────────────────────────

describe("TreeReader", () => {
  it("lists paths in code-unit order", async () => {
    const reader = await TreeReader.open(
      treeFromFiles(
        new Map([
          ["b.md", BETA],
          ["a.md", HELLO],
          ["A.md", HELLO],
        ]),
      ),
    );

    expect(reader.paths).toEqual(["A.md", "a.md", "b.md"]);
  });

  it("knows which paths the listing holds", async () => {
    const reader = await TreeReader.open(treeFromFiles(new Map([["a.md", HELLO]])));

    expect(reader.has("a.md")).toBe(true);
    expect(reader.has("b.md")).toBe(false);
  });

  it("fetches a file once and counts the read", async () => {
    const { tree, read } = hostTree([{ path: "a.md", blob: HELLO_BLOB }], new Map([["a.md", HELLO]]));
    const reader = await TreeReader.open(tree);

    expect(await reader.read("a.md")).toBe(HELLO);
    expect(reader.reads).toBe(1);
    expect(await reader.read("a.md")).toBe(HELLO);
    expect(reader.reads).toBe(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("a.md");
  });

  it("returns a listed blob id without reading the file", async () => {
    const reader = await TreeReader.open(treeFromFiles(new Map([["b.md", BETA]])));

    expect(await reader.blob("b.md")).toBe(BETA_BLOB);
    expect(reader.reads).toBe(0);
  });

  it("serves a second path with the same blob from the cache", async () => {
    const cache = new Map<string, string>();
    const reader = await TreeReader.open(
      treeFromFiles(
        new Map([
          ["a.md", HELLO],
          ["copy.md", HELLO],
        ]),
      ),
      cache,
    );

    expect(await reader.read("a.md")).toBe(HELLO);
    expect(await reader.read("copy.md")).toBe(HELLO);
    expect(reader.reads).toBe(1);
    expect(cache.get(HELLO_BLOB)).toBe(HELLO);
  });

  it("fetches a second path with the same blob when it has no cache", async () => {
    const reader = await TreeReader.open(
      treeFromFiles(
        new Map([
          ["a.md", HELLO],
          ["copy.md", HELLO],
        ]),
      ),
    );

    await reader.read("a.md");
    await reader.read("copy.md");
    expect(reader.reads).toBe(2);
  });

  it("serves a later reader from a shared cache", async () => {
    const cache = new Map<string, string>();
    const { tree, read } = hostTree([{ path: "a.md", blob: HELLO_BLOB }], new Map([["a.md", HELLO]]));

    const first = await TreeReader.open(tree, cache);
    await first.read("a.md");
    const second = await TreeReader.open(tree, cache);

    expect(await second.read("a.md")).toBe(HELLO);
    expect(first.reads).toBe(1);
    expect(second.reads).toBe(0);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("takes a listed blob's text from the cache without asking the host", async () => {
    const cache = new Map([[HELLO_BLOB, "from the cache\n"]]);
    const { tree, read } = hostTree([{ path: "a.md", blob: HELLO_BLOB }], new Map([["a.md", HELLO]]));
    const reader = await TreeReader.open(tree, cache);

    expect(await reader.read("a.md")).toBe("from the cache\n");
    expect(reader.reads).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });

  it("caches a fetched file under the blob id the host listed", async () => {
    const listed = "1111111111111111111111111111111111111111";
    const cache = new Map<string, string>();
    const { tree } = hostTree([{ path: "a.md", blob: listed }], new Map([["a.md", HELLO]]));
    const reader = await TreeReader.open(tree, cache);

    await reader.read("a.md");

    expect(cache.get(listed)).toBe(HELLO);
    expect(cache.has(HELLO_BLOB)).toBe(false);
    expect(await reader.blob("a.md")).toBe(listed);
  });

  it("reads a file the host listed without a blob to compute its id", async () => {
    const cache = new Map<string, string>();
    const { tree, read } = hostTree([{ path: "a.md" }], new Map([["a.md", HELLO]]));
    const reader = await TreeReader.open(tree, cache);

    expect(reader.paths).toEqual(["a.md"]);
    expect(await reader.blob("a.md")).toBe(HELLO_BLOB);
    expect(reader.reads).toBe(1);
    expect(cache.get(HELLO_BLOB)).toBe(HELLO);

    expect(await reader.read("a.md")).toBe(HELLO);
    expect(await reader.blob("a.md")).toBe(HELLO_BLOB);
    expect(reader.reads).toBe(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("fetches a file listed without a blob even when the cache holds its text", async () => {
    const cache = new Map([[HELLO_BLOB, HELLO]]);
    const { tree, read } = hostTree([{ path: "a.md" }], new Map([["a.md", HELLO]]));
    const reader = await TreeReader.open(tree, cache);

    expect(await reader.read("a.md")).toBe(HELLO);
    expect(reader.reads).toBe(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("rejects a path the tree does not hold and counts no read", async () => {
    const reader = await TreeReader.open(treeFromFiles(new Map([["a.md", HELLO]])));

    await expect(reader.read("missing.md")).rejects.toThrow("missing.md is not in the tree.");
    expect(reader.reads).toBe(0);
  });
});

// ── compareText ──────────────────────────────────────────────────────────────

describe("compareText", () => {
  it("returns 0 for equal texts and a sign for the order of different ones", () => {
    expect(compareText("a", "a")).toBe(0);
    expect(compareText("B", "a")).toBe(-1);
    expect(compareText("a", "B")).toBe(1);
  });

  it("sorts by code unit, not by locale", () => {
    // A locale sort puts "_" first and each lowercase letter beside its capital.
    expect(["b", "a", "_", "B", "A"].sort(compareText)).toEqual(["A", "B", "_", "a", "b"]);
  });

  it("compares UTF-16 code units, not code points", () => {
    // U+1F600 is stored as the surrogate pair D83D DE00, and D83D is below FB01.
    expect(compareText("\u{1F600}", "ﬁ")).toBe(-1);
    expect(compareText("ﬁ", "\u{1F600}")).toBe(1);
  });
});
