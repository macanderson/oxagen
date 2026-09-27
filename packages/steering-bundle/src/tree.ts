// tree.ts: the files of a steering repo at one commit, as publish reads them.
//
// A host lists a tree with each file's blob id, so publish learns which files
// changed without reading them. It reads a file only when its blob is new to
// the previous version and to the blob cache.
import { createHash } from "node:crypto";

/** One file in a tree listing. `blob` is absent when the host did not list it. */
export interface TreeEntry {
  path: string;
  blob?: string;
}

/** The files of a steering repo at one commit. */
export interface SteeringTree {
  /** Every file at the commit. */
  list(): Promise<readonly TreeEntry[]>;
  /** One file's text. */
  read(path: string): Promise<string>;
}

/** File texts by blob id, kept between publishes. A `Map` fits. */
export interface BlobCache {
  get(blob: string): string | undefined;
  set(blob: string, text: string): unknown;
}

/** The git blob id of a text: SHA-1 over `blob <bytes>\0` and the UTF-8 bytes, as `git hash-object` writes it. */
export function gitBlobId(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

/** A tree held in memory, such as a fixture repo. Each entry carries its blob id. */
export function treeFromFiles(files: ReadonlyMap<string, string>): SteeringTree {
  return {
    list: () =>
      Promise.resolve(
        [...files.entries()].map(([path, text]) => ({ path, blob: gitBlobId(text) })),
      ),
    read: (path) => {
      const text = files.get(path);
      if (text === undefined) {
        return Promise.reject(new Error(`${path} is not in the tree.`));
      }
      return Promise.resolve(text);
    },
  };
}

/**
 * A tree's listing with every blob id filled in, and a reader that asks the
 * cache before the host. A file whose blob the host did not list is read once
 * to compute it.
 */
export class TreeReader {
  private readonly texts = new Map<string, string>();
  private readonly blobs = new Map<string, string>();
  private readonly listed: ReadonlySet<string>;
  /** How many files this reader fetched from the host. */
  reads = 0;

  private constructor(
    private readonly tree: SteeringTree,
    private readonly cache: BlobCache | undefined,
    readonly paths: readonly string[],
  ) {
    this.listed = new Set(paths);
  }

  static async open(tree: SteeringTree, cache?: BlobCache): Promise<TreeReader> {
    const entries = await tree.list();
    const reader = new TreeReader(
      tree,
      cache,
      entries.map((entry) => entry.path).sort(compareText),
    );
    for (const entry of entries) {
      if (entry.blob !== undefined) reader.blobs.set(entry.path, entry.blob);
    }
    return reader;
  }

  has(path: string): boolean {
    return this.listed.has(path);
  }

  /** The file's blob id. */
  async blob(path: string): Promise<string> {
    const known = this.blobs.get(path);
    if (known !== undefined) return known;
    const text = await this.read(path);
    return this.blobs.get(path) ?? gitBlobId(text);
  }

  /** The file's text, from this reader, the cache, or the host. */
  async read(path: string): Promise<string> {
    const held = this.texts.get(path);
    if (held !== undefined) return held;
    const listed = this.blobs.get(path);
    const cached = listed === undefined ? undefined : this.cache?.get(listed);
    const text = cached ?? (await this.fetch(path));
    this.texts.set(path, text);
    if (listed === undefined) this.blobs.set(path, gitBlobId(text));
    return text;
  }

  private async fetch(path: string): Promise<string> {
    const text = await this.tree.read(path);
    this.reads += 1;
    this.cache?.set(this.blobs.get(path) ?? gitBlobId(text), text);
    return text;
  }
}

/** Code-unit order, the same on every machine and locale. */
export function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
