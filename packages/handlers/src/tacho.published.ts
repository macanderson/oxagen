// tacho.published.ts: what the Tacho host routes read of a workspace's
// published steering (steering-repo-spec, Shared contract: bundle/v1).
//
// Four host routes read it. get_tacho_bundle chooses the skills a host places
// at session start, and recall_tacho_memories ranks the merged memory records
// against one prompt. ingest_tacho_events and fetch_commands read the same
// skills for the bundle etag their control envelope publishes. All four read
// it through this port, so the version store that holds bundle/v1 binds in
// one place.
//
// `VERSION_STORE_PUBLISHED` binds the port to the Postgres version store that
// publish() writes (#4550), and every route uses it by default. It loads that
// binding on first use, so importing a handler opens no database client.
//
// `NOTHING_PUBLISHED` answers as if nothing had published: no version and no
// asset readable.
//
// The port reads the version published now. A run has to read the versions
// its request manifest names instead, and nothing reads those pins back yet.
// So the port takes a `HostScope`, whose run id is always null, and a
// run-scoped reader such as steering_search or steering_read cannot bind to
// it (#4447). tacho.published.test.ts proves that binding fails to compile.
import type { Delivery } from "@oxagen/steering-bundle";
import type { ReadAsset } from "@oxagen/steering-bundle/session";
import type { SteeringScope } from "./steering.search";

/**
 * The scope a Tacho host route reads for. A host route serves a host, not a
 * run, so its run id is null. The field stays, typed `null`, because a scope
 * without it would accept any `SteeringScope`, run id and all.
 */
export interface HostScope extends SteeringScope {
  runId: null;
}

/** The published steering one Tacho host route reads. */
export interface TachoPublished {
  /** The workspace's and the organization's versions published now, each null before its first publish. */
  published: (scope: HostScope) => Promise<Delivery>;
  /** Reads one file of a published version by its blob. A skill asset may be binary. */
  readAsset: ReadAsset;
}

/** The port before a version store is bound: nothing has published. */
export const NOTHING_PUBLISHED: TachoPublished = {
  published: async () => ({ workspace: null, organization: null }),
  readAsset: async (_source, _bundle, file) => {
    throw new Error(
      `No steering version store is bound, so ${file.path} cannot be read.`,
    );
  },
};

const bound = () =>
  import("./tacho.published.postgres").then((m) => m.postgresTachoPublished);

/** The port bound to the Postgres version store, loaded on first use. */
export const VERSION_STORE_PUBLISHED: TachoPublished = {
  published: async (scope) => (await bound()).published(scope),
  readAsset: async (source, bundle, file) =>
    (await bound()).readAsset(source, bundle, file),
};
