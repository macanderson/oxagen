// tacho.published.postgres.ts: the published steering the Tacho host routes
// read, bound to the Postgres version store (steering-repo-spec, Shared
// contract: bundle/v1; #4550).
//
// get_tacho_bundle and recall_tacho_memories read a workspace's published
// version through the TachoPublished port. This binds the port to the store
// that publish() writes, under the key the publisher stores versions by.
//
// The key comes from the workspace's binding in the database, so finding the
// version calls no forge. A version holds no file bodies: each record names
// its file by path and git blob id, and the body stays in the steering repo.
// So a file is read from the repo at the version's commit, checked against
// its blob id, and kept in a bounded cache. A warm cache reads nothing from
// the forge.
//
// No organization version exists yet. publish() builds workspace versions
// only, and the version tables require a workspace, so `organization` is
// always null here.
//
// Nothing here runs at import. The host and its clients are built on first
// use, so a handler can import this module lazily.
import { createHash } from "node:crypto";
import type { Bundle } from "@oxagen/oxagen/steering-repo/bundle";
import { readTomlFile } from "@oxagen/oxagen/steering-repo/files";
import {
  governanceSchema,
  resolveGovernance,
  type RecallUnreviewed,
} from "@oxagen/oxagen/steering-repo/governance";
import { GOVERNANCE_TOML_PATH } from "@oxagen/oxagen/steering-repo/paths";
import type { VersionStore } from "@oxagen/steering-bundle";
import type { ReadAsset } from "@oxagen/steering-bundle/session";
import { runInTenantScope } from "@oxagen/tenancy";
import type {
  SteeringHost,
  SteeringProvider,
  SteeringRepository,
} from "./context.steering.github";
import {
  createSteeringHost,
  readSteeringConnection,
} from "./context.steering.host";
import { logger } from "./logger";
import { steeringRepositoryKey } from "./steering-repo/publisher";
import {
  postgresVersionStore,
  type VersionScope,
} from "./steering-repo/version-store";
import type { TachoPublished } from "./tacho.published";

/** Where the binding logs a refusal or a fallback to off. */
export interface PublishedLog {
  warn(fields: Record<string, unknown>, message: string): void;
}

/** What the binding reads through. Production leaves each one unset. */
export interface PostgresTachoPublishedDeps {
  /** One workspace's version store. The Postgres store when unset. */
  store?: (scope: VersionScope) => Pick<VersionStore, "current">;
  /** The host that resolves the steering repo and reads its files. Built on first use when unset. */
  host?: Pick<SteeringHost, "resolveRepository" | "readFile">;
  /** The workspace's steering binding, read from the database alone. */
  readConnection?: typeof readSteeringConnection;
  /** The handlers' logger when unset. */
  log?: PublishedLog;
  /** How many file bodies, and how many governance readings, the process keeps. */
  cacheEntries?: number;
}

// Recall reads every memory record on each prompt, so a workspace with more
// records than this reads some of them from the forge on every prompt.
const CACHE_ENTRIES = 256;

/** Where a version this binding returned came from, so its files can be read. */
interface Origin {
  scope: VersionScope;
  /**
   * The steering repo's handle, resolved once per version on its first file
   * read. Recall reads eight records at once, and each would otherwise make
   * its own forge call.
   */
  repo?: Promise<SteeringRepository>;
}

/** A map that keeps only its most recently used entries. */
function recentlyUsed<V>(limit: number) {
  const bound = Math.max(1, Math.floor(limit));
  const entries = new Map<string, V>();
  return {
    get(key: string): V | undefined {
      const value = entries.get(key);
      if (value !== undefined) {
        entries.delete(key);
        entries.set(key, value);
      }
      return value;
    },
    set(key: string, value: V): void {
      entries.delete(key);
      entries.set(key, value);
      for (const oldest of entries.keys()) {
        if (entries.size <= bound) break;
        entries.delete(oldest);
      }
    },
  };
}

/**
 * The key the publisher stores a bound repository's versions under, from the
 * database alone. steeringRepositoryKey reads only `provider` and `fullName`,
 * and both hosts' resolveRepository set `fullName` to the binding's approved
 * name. So these two fields give the publisher's key without a forge call, and
 * the cast stands in for the fields the key never reads.
 */
function bindingKey(provider: SteeringProvider, approvedFullName: string) {
  const named: Pick<SteeringRepository, "provider" | "fullName"> = {
    provider,
    fullName: approvedFullName,
  };
  return steeringRepositoryKey(named as SteeringRepository);
}

/**
 * The git blob id of a text: the hash of `blob <bytes>\0` and its UTF-8
 * bytes, as `git hash-object` writes it. A 64-character id comes from a
 * SHA-256 repository, and a 40-character one from a SHA-1 repository.
 */
function gitBlobIdLike(blob: string, text: string): string {
  const bytes = Buffer.from(text, "utf8");
  return createHash(blob.length === 64 ? "sha256" : "sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

/** The `recall_unreviewed` a governance file puts in force, or off and why. */
function recallFrom(text: string | null): {
  value: RecallUnreviewed;
  problem: string | null;
} {
  if (text === null) {
    return {
      value: "off",
      problem: `${GOVERNANCE_TOML_PATH} is not in the published version`,
    };
  }
  const read = readTomlFile(text, "governance/v1", governanceSchema);
  if (!read.ok) {
    const first = read.issues[0];
    return {
      value: "off",
      problem: `${GOVERNANCE_TOML_PATH}${first?.line ? ` line ${first.line}` : ""}: ${first?.message ?? "is not governance/v1"}`,
    };
  }
  // resolveGovernance turns recall off in regulated mode, whatever the file sets.
  return {
    value: resolveGovernance(read.value).recall_unreviewed,
    problem: null,
  };
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The TachoPublished port over one version store per workspace. */
export function createPostgresTachoPublished(
  deps: PostgresTachoPublishedDeps = {},
): TachoPublished {
  const storeOf = deps.store ?? postgresVersionStore;
  const readConnection = deps.readConnection ?? readSteeringConnection;
  const log: PublishedLog = deps.log ?? {
    warn: (fields, message) => logger.warn(fields, message),
  };
  let host = deps.host;
  const hostOf = () => (host ??= createSteeringHost());
  // A version object maps to the workspace that read it. The store parses a
  // fresh object on each read, and both routes pass that same object back to
  // readAsset, so an entry lives only as long as one request holds it.
  const origins = new WeakMap<Bundle, Origin>();
  // File bodies by workspace and blob id. The workspace is in the key so one
  // tenant's read never answers another's, even for the same content.
  const bodies = recentlyUsed<string>(deps.cacheEntries ?? CACHE_ENTRIES);
  // Readings of recall_unreviewed by workspace, repository, and commit. A
  // commit's governance file never changes, so a reading holds until evicted.
  const readings = recentlyUsed<RecallUnreviewed>(
    deps.cacheEntries ?? CACHE_ENTRIES,
  );

  // Each read opens the workspace's tenant scope, as the version store does,
  // because the binding and the host read tenant tables.
  const inScope = <T>(scope: VersionScope, fn: () => Promise<T>) =>
    runInTenantScope({ orgId: scope.orgId, workspaceId: scope.workspaceId }, fn);

  /** The key the workspace's versions are stored under, or null with no binding. */
  async function repositoryKey(origin: Origin): Promise<string | null> {
    const { scope } = origin;
    const connection = await inScope(scope, () => readConnection(scope));
    if (connection === null) return null;
    if (connection.source === "binding") {
      return bindingKey(
        connection.provider ?? "github",
        connection.approvedFullName,
      );
    }
    // A legacy connection records no approved name, so the publisher keyed it
    // by the name GitHub reports now. Reading that name costs a forge call on
    // every read, and the handle it returns serves this version's file reads.
    const repo = inScope(scope, () => hostOf().resolveRepository(scope));
    origin.repo = repo;
    return steeringRepositoryKey(await repo);
  }

  /** The version published now, and where it came from, or null before the first. */
  async function currentVersion(
    scope: VersionScope,
  ): Promise<{ bundle: Bundle; origin: Origin } | null> {
    const origin: Origin = { scope };
    const key = await repositoryKey(origin);
    if (key === null) return null;
    const bundle = await storeOf(scope).current(key);
    if (bundle === null) return null;
    origins.set(bundle, origin);
    return { bundle, origin };
  }

  /**
   * The steering repo a version was built from. A handle whose key differs
   * from the version's names another repository: the workspace's steering
   * head moved since that version published, so its files are refused.
   */
  async function repoOf(
    origin: Origin,
    bundle: Bundle,
  ): Promise<SteeringRepository> {
    const pending = (origin.repo ??= inScope(origin.scope, () =>
      hostOf().resolveRepository(origin.scope),
    ));
    const repo = await pending;
    const key = steeringRepositoryKey(repo);
    if (key !== bundle.repository) {
      throw new Error(
        `The workspace's steering repo is ${key} now, not ${bundle.repository}, so version ${bundle.version} cannot be read from it.`,
      );
    }
    return repo;
  }

  const readAsset: ReadAsset = async (source, bundle, file) => {
    if (source !== "workspace") {
      throw new Error(
        `No organization version is published, so ${file.path} cannot be read from one.`,
      );
    }
    const origin = origins.get(bundle);
    if (origin === undefined) {
      throw new Error(
        `${file.path} belongs to a version this reader did not return, so it cannot tell which workspace's repository holds it.`,
      );
    }
    const cacheKey = `${origin.scope.workspaceId}:${file.blob}`;
    const cached = bodies.get(cacheKey);
    if (cached !== undefined) return cached;
    const repo = await repoOf(origin, bundle);
    const text = await inScope(origin.scope, () =>
      hostOf().readFile(repo, file.path, bundle.commit),
    );
    if (text === null) {
      throw new Error(
        `${file.path} is not in ${bundle.repository} at ${bundle.commit}.`,
      );
    }
    // The host reads a file as UTF-8 text, so the check refuses a binary file
    // as well as a changed one: decoding already altered its bytes.
    const actual = gitBlobIdLike(file.blob, text);
    if (actual !== file.blob) {
      throw new Error(
        `${file.path} at ${bundle.commit} hashes to ${actual}, not to the blob ${file.blob} its version names.`,
      );
    }
    bodies.set(cacheKey, text);
    return text;
  };

  return {
    // A run's request manifest names the versions it received, but nothing
    // reads those pins back yet. So a run reads the versions published now,
    // like a call from outside a run.
    published: async (scope) => {
      const current = await currentVersion({
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
      });
      return { workspace: current?.bundle ?? null, organization: null };
    },

    readAsset,

    // Off is the answer whenever the setting cannot be read: before the first
    // publish, with no governance file, and on any failure. A workspace in
    // regulated mode turns unreviewed recall off, so off is the safe guess.
    async recallUnreviewed(scope) {
      const where = { orgId: scope.orgId, workspaceId: scope.workspaceId };
      try {
        const current = await currentVersion(where);
        if (current === null) return "off";
        const { bundle, origin } = current;
        const key = `${where.workspaceId}:${bundle.repository}@${bundle.commit}`;
        const known = readings.get(key);
        if (known !== undefined) return known;
        const repo = await repoOf(origin, bundle);
        const text = await inScope(where, () =>
          hostOf().readFile(repo, GOVERNANCE_TOML_PATH, bundle.commit),
        );
        const reading = recallFrom(text);
        if (reading.problem !== null) {
          log.warn(
            {
              ...where,
              repository: bundle.repository,
              commit: bundle.commit,
              problem: reading.problem,
            },
            "tacho.published: the published governance file cannot be read, so unreviewed memories stay off",
          );
        }
        // A missing or unreadable file is a fact of the commit, so it is kept
        // like a reading. A failed read is not kept, and the next call retries.
        readings.set(key, reading.value);
        return reading.value;
      } catch (error) {
        log.warn(
          { ...where, err: messageOf(error) },
          "tacho.published: the published governance could not be read, so unreviewed memories stay off",
        );
        return "off";
      }
    },
  };
}

/** The binding the Tacho host routes use in production. */
export const postgresTachoPublished: TachoPublished =
  createPostgresTachoPublished();
