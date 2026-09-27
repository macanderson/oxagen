// publish.ts: a merge becomes the next published version (steering-repo-spec,
// Steering PR flow: Publish).
//
// Flow:
//   1. The repository's health. Anything but healthy refuses, and runs keep
//      the last published version.
//   2. Under the repository's publish lock: a commit that is already
//      published is done, so a repeated webhook changes nothing.
//   3. A commit that is no longer the branch head is stale and is not
//      published. Two syncs can finish in either order, and without this the
//      older merge would publish last and roll every run back to it.
//   4. The next number: one more than the highest ever stored, so a number is
//      never reused, even for a version that stored and never published.
//   5. The bundle, built from the merged tree. Files whose blob the previous
//      version or the cache already holds are not read again.
//   6. MCP Studio's project() (lane M13), so the tool registry follows the
//      merge. It gets every folder under tools/servers/, so it can tell a
//      server that did not compile from one the merge removed. Until M13
//      builds it, publish goes on with a warning.
//   7. Store the version, then switch the published version in one write.
//      When either write fails after project() ran, the registry is projected
//      back to the published version, with the folders at that version's
//      commit, so runs never get tools from a version they were not
//      delivered. The next sync publishes the head again.
//   8. Tag the merge commit steering/<number>. The version is already live,
//      so a tag that fails is a warning.
import { NotBuiltError } from "@oxagen/mcp-studio";
import type { Bundle } from "@oxagen/oxagen/steering-repo/bundle";
import type { RepoHealth } from "@oxagen/oxagen/steering-repo/health";
import { buildBundle, type BundleIdentity } from "./build";
import { serverNames, type ToolCompiler } from "./tools";
import { TreeReader, type BlobCache, type SteeringTree } from "./tree";

/** The published version's number, its merge commit, and its ledger line, switched in one write. */
export interface PublishedPointer {
  version: number;
  commit: string;
  ledger: Bundle["ledger"];
}

/** A stored version's number, and whether it was ever the published one. */
export interface StoredVersion {
  version: number;
  published: boolean;
}

/** Where published versions live. Keyed by the steering repo or the organization repo. */
export interface VersionStore {
  /** Runs `fn` while no other publish of the repository runs. */
  withLock<T>(repository: string, fn: () => Promise<T>): Promise<T>;
  /** The published version, or null before the first. */
  current(repository: string): Promise<Bundle | null>;
  /** The highest number ever stored for the repository, published or not, or 0. */
  highestVersion(repository: string): Promise<number>;
  /**
   * The newest version stored from `commit`, and whether it was ever made the
   * published one. Null when no version was built from the commit. A merge
   * that resumes after its publish reads this to learn the number it got.
   */
  versionAt(repository: string, commit: string): Promise<StoredVersion | null>;
  /** Keep a built version. This does not publish it. */
  put(bundle: Bundle): Promise<void>;
  /** Make a stored version the published one, in one write. */
  setPublished(repository: string, pointer: PublishedPointer): Promise<void>;
}

export interface PublishDeps {
  store: VersionStore;
  /** The repository's health (lane S2). */
  health: (repository: string) => Promise<RepoHealth>;
  /** The commit the repository's production branch points at now. */
  head: (repository: string) => Promise<string>;
  /** The merged tree, listed with blob ids. */
  tree: (repository: string, commit: string) => Promise<SteeringTree>;
  /** Tags the commit. */
  tag: (repository: string, name: string, commit: string) => Promise<void>;
  /**
   * MCP Studio's project() (lane M13). Unset until it is built. `folders`
   * names every folder under tools/servers/ at the bundle's commit, including
   * servers that did not compile, so project() retires only the servers a
   * merge removed.
   */
  project?: (bundle: Bundle, options?: { folders?: string[] }) => Promise<void>;
  /** Compiles a server folder. MCP Studio's compile() when unset. */
  compiler?: ToolCompiler;
  /** File texts by blob id, shared between publishes. */
  cache?: BlobCache;
  now: () => Date;
}

export type PublishResult =
  | { status: "refused"; health: Exclude<RepoHealth, "healthy"> }
  | { status: "current"; version: number; commit: string }
  /** `commit` is no longer the branch head, so it was not published. `head` is the commit the branch points at now. */
  | { status: "stale"; commit: string; head: string }
  | {
      status: "published";
      version: number;
      commit: string;
      bundle: Bundle;
      /** The tag on the merge commit, or null when tagging failed. */
      tag: string | null;
      warnings: string[];
      /** How many files the build fetched from the host. */
      reads: number;
    };

/** The tag a published version puts on its merge commit. */
export function versionTag(version: number): string {
  return `steering/${version}`;
}

/** Publish the merge at `commit` as the repository's next version. */
export async function publish(
  deps: PublishDeps,
  identity: BundleIdentity,
  commit: string,
): Promise<PublishResult> {
  const repository = identity.repository;
  const health = await deps.health(repository);
  if (health !== "healthy") return { status: "refused", health };

  return deps.store.withLock(repository, async () => {
    const current = await deps.store.current(repository);
    if (current !== null && current.commit === commit) {
      return { status: "current", version: current.version, commit };
    }
    const head = await deps.head(repository);
    if (head !== commit) return { status: "stale", commit, head };
    const version = (await deps.store.highestVersion(repository)) + 1;
    const reader = await TreeReader.open(await deps.tree(repository, commit), deps.cache);
    const { bundle, warnings } = await buildBundle({
      identity,
      version,
      commit,
      published_at: deps.now().toISOString(),
      reader,
      previous: current,
      compiler: deps.compiler,
    });

    const projected = await projectBundle(deps, bundle, serverNames(reader.paths), warnings);
    try {
      await deps.store.put(bundle);
      await deps.store.setPublished(repository, { version, commit, ledger: bundle.ledger });
    } catch (error) {
      if (projected) await restoreProjection(deps, repository, current, version, error);
      throw error;
    }

    let tag: string | null = versionTag(version);
    try {
      await deps.tag(repository, tag, commit);
    } catch (error) {
      warnings.push(
        `Version ${version} is published, but the tag ${tag} was not written: ${(error as Error).message}`,
      );
      tag = null;
    }
    return {
      status: "published",
      version,
      commit,
      bundle,
      tag,
      warnings,
      reads: reader.reads,
    };
  });
}

/**
 * Project the bundle into MCP Studio's tool registry. Returns true when the
 * registry now holds the bundle's tools, and false when project() is not
 * built, with a warning.
 */
async function projectBundle(
  deps: PublishDeps,
  bundle: Bundle,
  folders: string[],
  warnings: string[],
): Promise<boolean> {
  if (deps.project === undefined) {
    warnings.push("The tool registry was not updated: MCP Studio's project() is not built yet.");
    return false;
  }
  try {
    await deps.project(bundle, { folders });
    return true;
  } catch (error) {
    if (!(error instanceof NotBuiltError)) throw error;
    warnings.push(
      `The tool registry was not updated: MCP Studio's ${error.module} is not built yet.`,
    );
    return false;
  }
}

/**
 * Project the published version back after the store refused the new one.
 * The server folders come from the tree at the published version's commit,
 * because a bundle names only the servers that compiled. Before the first
 * version there is nothing to put back, and the next sync publishes the head
 * again. When reading that tree or this projection fails too, both failures
 * are thrown together.
 */
async function restoreProjection(
  deps: PublishDeps,
  repository: string,
  previous: Bundle | null,
  version: number,
  failure: unknown,
): Promise<void> {
  if (deps.project === undefined || previous === null) return;
  try {
    const entries = await (await deps.tree(repository, previous.commit)).list();
    const folders = serverNames(entries.map((entry) => entry.path));
    await deps.project(previous, { folders });
  } catch (undone) {
    throw new AggregateError(
      [failure, undone],
      `Version ${version} was not published, and MCP Studio's registry could not be put back on version ${previous.version}. The next publish projects the registry again.`,
    );
  }
}

/**
 * A version store held in memory, for tests and for a single process. Its
 * lock queues publishes of one repository behind each other.
 */
export function memoryVersionStore(): VersionStore & {
  versions: Map<string, Bundle[]>;
  published: Map<string, PublishedPointer>;
} {
  const versions = new Map<string, Bundle[]>();
  const published = new Map<string, PublishedPointer>();
  // Every version setPublished ever named, as `<repository>#<version>`. A
  // bundle's published_at is stamped at build time, so it cannot tell.
  const named = new Set<string>();
  const locks = new Map<string, Promise<unknown>>();
  return {
    versions,
    published,
    withLock<T>(repository: string, fn: () => Promise<T>): Promise<T> {
      const before = locks.get(repository) ?? Promise.resolve();
      const run = before.then(fn, fn);
      locks.set(
        repository,
        run.then(
          () => undefined,
          () => undefined,
        ),
      );
      return run;
    },
    current(repository) {
      const pointer = published.get(repository);
      if (pointer === undefined) return Promise.resolve(null);
      const bundle = versions
        .get(repository)
        ?.find((entry) => entry.version === pointer.version);
      return Promise.resolve(bundle ?? null);
    },
    highestVersion(repository) {
      const stored = versions.get(repository) ?? [];
      return Promise.resolve(stored.reduce((high, entry) => Math.max(high, entry.version), 0));
    },
    versionAt(repository, commit) {
      const built = (versions.get(repository) ?? []).filter((entry) => entry.commit === commit);
      if (built.length === 0) return Promise.resolve(null);
      const version = built.reduce((high, entry) => Math.max(high, entry.version), 0);
      return Promise.resolve({ version, published: named.has(`${repository}#${version}`) });
    },
    put(bundle) {
      const stored = versions.get(bundle.repository) ?? [];
      if (stored.some((entry) => entry.version === bundle.version)) {
        return Promise.reject(
          new Error(`${bundle.repository} already stored version ${bundle.version}.`),
        );
      }
      versions.set(bundle.repository, [...stored, bundle]);
      return Promise.resolve();
    },
    setPublished(repository, pointer) {
      published.set(repository, pointer);
      named.add(`${repository}#${pointer.version}`);
      return Promise.resolve();
    },
  };
}
