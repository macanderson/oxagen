// publish.ts: a merge becomes the next published version (steering-repo-spec,
// Steering PR flow: Publish).
//
// Flow:
//   1. The repository's health. Anything but healthy refuses, and runs keep
//      the last published version.
//   2. Under the repository's publish lock: a commit that is already
//      published is done, so a repeated webhook changes nothing.
//   3. The next number: one more than the highest ever stored, so a number is
//      never reused, even for a version that stored and never published.
//   4. The bundle, built from the merged tree. Files whose blob the previous
//      version or the cache already holds are not read again.
//   5. MCP Studio's project() (lane M13), so the tool registry follows the
//      merge. Until M13 builds it, publish goes on with a warning.
//   6. Store the version, then switch the published version in one write.
//   7. Tag the merge commit steering/<number>. The version is already live,
//      so a tag that fails is a warning.
import { NotBuiltError } from "@oxagen/mcp-studio";
import type { Bundle } from "@oxagen/oxagen/steering-repo/bundle";
import type { RepoHealth } from "@oxagen/oxagen/steering-repo/health";
import { buildBundle, type BundleIdentity } from "./build";
import type { ToolCompiler } from "./tools";
import { TreeReader, type BlobCache, type SteeringTree } from "./tree";

/** The published version's number, its merge commit, and its ledger line, switched in one write. */
export interface PublishedPointer {
  version: number;
  commit: string;
  ledger: Bundle["ledger"];
}

/** Where published versions live. Keyed by the steering repo or the organization repo. */
export interface VersionStore {
  /** Runs `fn` while no other publish of the repository runs. */
  withLock<T>(repository: string, fn: () => Promise<T>): Promise<T>;
  /** The published version, or null before the first. */
  current(repository: string): Promise<Bundle | null>;
  /** The highest number ever stored for the repository, published or not, or 0. */
  highestVersion(repository: string): Promise<number>;
  /** Keep a built version. This does not publish it. */
  put(bundle: Bundle): Promise<void>;
  /** Make a stored version the published one, in one write. */
  setPublished(repository: string, pointer: PublishedPointer): Promise<void>;
}

export interface PublishDeps {
  store: VersionStore;
  /** The repository's health (lane S2). */
  health: (repository: string) => Promise<RepoHealth>;
  /** The merged tree, listed with blob ids. */
  tree: (repository: string, commit: string) => Promise<SteeringTree>;
  /** Tags the commit. */
  tag: (repository: string, name: string, commit: string) => Promise<void>;
  /** MCP Studio's project() (lane M13). Unset until it is built. */
  project?: (bundle: Bundle) => Promise<void>;
  /** Compiles a server folder. MCP Studio's compile() when unset. */
  compiler?: ToolCompiler;
  /** File texts by blob id, shared between publishes. */
  cache?: BlobCache;
  now: () => Date;
}

export type PublishResult =
  | { status: "refused"; health: Exclude<RepoHealth, "healthy"> }
  | { status: "current"; version: number; commit: string }
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

    if (deps.project === undefined) {
      warnings.push("The tool registry was not updated: MCP Studio's project() is not built yet.");
    } else {
      try {
        await deps.project(bundle);
      } catch (error) {
        if (!(error instanceof NotBuiltError)) throw error;
        warnings.push(
          `The tool registry was not updated: MCP Studio's ${error.module} is not built yet.`,
        );
      }
    }

    await deps.store.put(bundle);
    await deps.store.setPublished(repository, { version, commit, ledger: bundle.ledger });

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
 * A version store held in memory, for tests and for a single process. Its
 * lock queues publishes of one repository behind each other.
 */
export function memoryVersionStore(): VersionStore & {
  versions: Map<string, Bundle[]>;
  published: Map<string, PublishedPointer>;
} {
  const versions = new Map<string, Bundle[]>();
  const published = new Map<string, PublishedPointer>();
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
      return Promise.resolve();
    },
  };
}
