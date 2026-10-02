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
import type { Delivery, VersionStore } from "@oxagen/steering-bundle";
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
import { steeringRepositoryKey } from "./steering-repo/publisher";
import {
  postgresVersionStore,
  type VersionScope,
} from "./steering-repo/version-store";
import type { TachoPublished } from "./tacho.published";

/** What the binding reads through. Production leaves each one unset. */
export interface PostgresTachoPublishedDeps {
  /** One workspace's version store. The Postgres store when unset. */
  store?: (scope: VersionScope) => Pick<VersionStore, "current">;
  /** The host that resolves the steering repo and reads its files. Built on first use when unset. */
  host?: Pick<SteeringHost, "resolveRepository" | "readFile">;
  /** The workspace's steering binding, read from the database alone. */
  readConnection?: typeof readSteeringConnection;
  /** How many UTF-8 bytes of file bodies the process keeps. */
  cacheBytes?: number;
}

// Recall reads every memory record on each prompt. 16 MiB holds about 8,000
// records of 2 KiB, across every workspace this process serves. Past that, the
// oldest bodies go first, and a recall that reads more than the budget in one
// pass reads some of them from the forge on every prompt.
const CACHE_BYTES = 16 * 1024 * 1024;

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

/**
 * A map of texts that keeps its most recently used entries within a UTF-8
 * byte budget. A text larger than the whole budget is not kept.
 */
function recentlyUsedBytes(budget: number) {
  const bound = Math.max(0, Math.floor(budget));
  const entries = new Map<string, { text: string; bytes: number }>();
  let total = 0;
  const drop = (key: string) => {
    const held = entries.get(key);
    if (held === undefined) return;
    entries.delete(key);
    total -= held.bytes;
  };
  return {
    get(key: string): string | undefined {
      const held = entries.get(key);
      if (held === undefined) return undefined;
      entries.delete(key);
      entries.set(key, held);
      return held.text;
    },
    set(key: string, text: string): void {
      drop(key);
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > bound) return;
      entries.set(key, { text, bytes });
      total += bytes;
      for (const oldest of entries.keys()) {
        if (total <= bound) break;
        drop(oldest);
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

const BOM = "\uFEFF";

/**
 * The body whose blob id is `blob`, from the text the host read, or null when
 * none matches. GitHub's read keeps a leading byte order mark. GitLab's read
 * decodes with Response.text(), which drops it, so a file that starts with one
 * is tried again with the mark put back.
 */
function bodyMatching(blob: string, text: string): string | null {
  if (gitBlobIdLike(blob, text) === blob) return text;
  if (!text.startsWith(BOM) && gitBlobIdLike(blob, BOM + text) === blob) {
    return BOM + text;
  }
  return null;
}

/** The TachoPublished port over one version store per workspace. */
export function createPostgresTachoPublished(
  deps: PostgresTachoPublishedDeps = {},
): TachoPublished {
  const storeOf = deps.store ?? postgresVersionStore;
  const readConnection = deps.readConnection ?? readSteeringConnection;
  let host = deps.host;
  const hostOf = () => (host ??= createSteeringHost());
  // A version object maps to the workspace that read it. The store parses a
  // fresh object on each read, and both routes pass that same object back to
  // readAsset, so an entry lives only as long as one request holds it.
  const origins = new WeakMap<Bundle, Origin>();
  // File bodies by workspace and blob id. The workspace is in the key so one
  // tenant's read never answers another's, even for the same content.
  const bodies = recentlyUsedBytes(deps.cacheBytes ?? CACHE_BYTES);

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
    // as well as a changed one: decoding already altered its bytes. A skill
    // that ships a binary file is dropped from the session on its own, by
    // get_tacho_bundle, and the other skills still arrive.
    const body = bodyMatching(file.blob, text);
    if (body === null) {
      throw new Error(
        `${file.path} at ${bundle.commit} hashes to ${gitBlobIdLike(file.blob, text)}, not to the blob ${file.blob} its version names.`,
      );
    }
    bodies.set(cacheKey, body);
    return body;
  };

  // The reads in flight, by workspace. A host route reads the skills and the
  // Cedar policies at once, and each asks for the published version, so the
  // second ask joins the first read instead of making its own. A legacy
  // connection costs a forge call per read, which this halves. The entry
  // goes when the read settles, so a later ask reads the store again. The
  // read sets its own tenant scope with no principal, so whichever request
  // started it, the answer is the same.
  const reading = new Map<string, Promise<Delivery>>();

  return {
    // The version published now. A run's request manifest names the
    // versions it received, but nothing reads those pins back yet, so the
    // port's scope has a null run id and no run can read through it (#4447).
    published: (scope) => {
      const key = `${scope.orgId}:${scope.workspaceId}`;
      const pending = reading.get(key);
      if (pending !== undefined) return pending;
      const read = currentVersion({
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
      })
        .then(
          (current): Delivery => ({
            workspace: current?.bundle ?? null,
            organization: null,
          }),
        )
        .finally(() => reading.delete(key));
      reading.set(key, read);
      return read;
    },

    readAsset,
  };
}

/** The binding the Tacho host routes use in production. */
export const postgresTachoPublished: TachoPublished =
  createPostgresTachoPublished();
