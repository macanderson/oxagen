// tacho.published.ts: what the Tacho host routes read of a workspace's
// published steering (steering-repo-spec, Shared contract: bundle/v1).
//
// Two host routes read it. get_tacho_bundle chooses the skills a host places
// at session start, and recall_tacho_memories ranks the merged memory records
// against one prompt. Both read it through this port, so the version store
// that holds bundle/v1 binds in one place.
//
// `VERSION_STORE_PUBLISHED` binds the port to the Postgres version store that
// publish() writes (#4550), and both routes use it by default. It loads that
// binding on first use, so importing a handler opens no database client.
//
// `NOTHING_PUBLISHED` answers as if nothing had published: no version, no
// asset readable, and unreviewed memories off. Off is the safe reading of a
// governance file Oxagen cannot see, because a workspace in `regulated` mode
// turns unreviewed recall off whatever else it sets.
import type { GovernanceSettings } from "@oxagen/oxagen/steering-repo/governance";
import type { ReadAsset } from "@oxagen/steering-bundle/session";
import type { ReadPublished } from "./steering.search";

/** The published steering one Tacho host route reads. */
export interface TachoPublished {
  /** The workspace's and the organization's published versions, each null before its first publish. */
  published: ReadPublished;
  /** Reads one file of a published version by its blob. A skill asset may be binary. */
  readAsset: ReadAsset;
  /** The workspace's `recall_unreviewed`, as its governance file puts it in force. */
  recallUnreviewed(scope: {
    orgId: string;
    workspaceId: string;
  }): Promise<GovernanceSettings["recall_unreviewed"]>;
}

/** The port before a version store is bound: nothing has published. */
export const NOTHING_PUBLISHED: TachoPublished = {
  published: async () => ({ workspace: null, organization: null }),
  readAsset: async (_source, _bundle, file) => {
    throw new Error(
      `No steering version store is bound, so ${file.path} cannot be read.`,
    );
  },
  recallUnreviewed: async () => "off",
};

const bound = () =>
  import("./tacho.published.postgres").then((m) => m.postgresTachoPublished);

/** The port bound to the Postgres version store, loaded on first use. */
export const VERSION_STORE_PUBLISHED: TachoPublished = {
  published: async (scope) => (await bound()).published(scope),
  readAsset: async (source, bundle, file) =>
    (await bound()).readAsset(source, bundle, file),
  recallUnreviewed: async (scope) => (await bound()).recallUnreviewed(scope),
};
