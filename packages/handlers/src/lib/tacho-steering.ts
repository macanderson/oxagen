/**
 * The workspace's steering, assembled into the text the policy bundle carries
 * as `context.system` and the manifest it carries as `context.manifest`
 * (ADR-091, ADR-093, ADR-144).
 *
 * A context record merged through a Context PR is published with a `force`.
 * Every active record is a candidate; `@oxagen/steering-assembler` ranks the
 * candidates by tier and then by recency, fits the `must` and `should` ones
 * to the budget, and says in the manifest what happened to each: included,
 * or cut for its tier, for the budget, or because a newer version of its
 * lineage won. The collector hands `context.system` to the agent at session
 * start (Claude Code's `SessionStart` `additionalContext`) and seals the
 * manifest into the run's chain as a `steering.manifest` frame, so a record
 * reaches a run the moment the host next fetches its bundle, and the run
 * record says whether it did.
 *
 * The record read and the adapter from a row to a candidate live in
 * `@oxagen/agent` (`src/runtime/published-steering.ts`), because the in-app
 * assistant's turn reads the same records and `@oxagen/agent` is the lower
 * of the two packages. This module keeps what only the bundle needs: the
 * bundle's budget, the manifest cap, and the cache. What a record says is
 * read from the version it pins, not from the record row (#3312); that
 * module explains how.
 *
 * The assembly is cached per workspace, keyed on the workspace's steering
 * version (#3311). Every control poll and every event ingest carries the
 * bundle etag, and the etag is a digest of the bundle's content, so without
 * a cache every one of those responses loaded and ranked every steering
 * record in the workspace. The key carries the promotions ledger length, the
 * count of active steering records, and a digest of their pins, activation
 * instants and record classifications. Direct publication changes a pin
 * without appending a promotion. Legacy versions use the record
 * classification, so those fields also participate in the digest. Soft
 * deletion changes the active set. None of these writes needs an in-process
 * cache notification.
 *
 * The four version columns arrive in migration `20260918160000`, and
 * production applies migrations by hand while `deploy-node` ships on merge
 * without waiting. So every read here asks `information_schema` first and
 * names the version columns only once they exist; until then it assembles
 * from the record row alone, which is what this module did before #3312 and
 * is the right answer for a database on which no version can yet carry a
 * classification. The probe's answer is part of the cache key, so the text
 * assembled during the window is dropped the moment the columns land rather
 * than outliving it.
 *
 * No version counter travels in the bundle. The bundle etag is a digest of
 * the bundle's content, so a merge that adds, retires or supersedes a record
 * changes the text, the etag, and the next poll fetches the new bundle.
 */
import {
  classificationOf,
  readSteeringRows,
  readSteeringVersion,
  recordCandidate,
  type SteeringRecord,
  type SteeringTx,
  versionClassificationReady,
} from "@oxagen/agent/runtime/published-steering";
import { ambientPlaneKey } from "@oxagen/database";
import {
  assembleSteering,
  PREFIX_BUDGET_TOKENS,
  type SteeringCandidate,
  type SteeringManifest,
} from "@oxagen/steering-assembler";

// The record read moved to `@oxagen/agent` with the in-app assistant's use of
// it. Its names stay importable from here, so the bundle's callers and tests
// did not move with it.
export {
  classificationOf,
  recordCandidate,
  type SteeringRecord,
  type SteeringRow,
  type SteeringTx,
  type SteeringVersionRow,
} from "@oxagen/agent/runtime/published-steering";

/**
 * The host's limit on `context.system` (`policyBundleSchema` in
 * `@oxagen/tacho` `wire.ts`). The host parses the bundle `.strict()`, so a
 * longer string would make it reject the whole bundle and keep its old
 * mandate. The assembler stays under it by leaving records out.
 */
export const CONTEXT_SYSTEM_MAX_CHARS = 16_384;

/**
 * The assembler's budget for `context.system`, in Context Graph Protocol
 * budget tokens (`ceil(utf8_bytes / 4)`). The host would take 16,384
 * characters, but the harness it hands the text to reads less: Claude Code
 * replaces anything past 10,000 characters with a file path and a preview,
 * so a record the manifest called included never reached the agent. The
 * assembler's `PREFIX_BUDGET_TOKENS` fits the smallest harness limit, and a
 * string never has more characters than bytes, so it also fits the host's.
 * That is at most 8,000 characters, which leaves room under the collector's
 * 9,500-character total for one hook answer; a steer that does not fit
 * beside this text waits for the next prompt.
 */
export const CONTEXT_SYSTEM_BUDGET_TOKENS = Math.min(
  PREFIX_BUDGET_TOKENS,
  CONTEXT_SYSTEM_MAX_CHARS / 4,
);

/**
 * The most items the signed manifest lists. The host parses
 * `context.manifest` `.strict()` with at most 2,000 items
 * (`steeringManifestSchema` in `@oxagen/tacho` `wire.ts`), so a longer list
 * would make every host that reads the manifest reject the whole bundle and
 * keep its old mandate. The 100 below that are room for the steers the host
 * appends to the frame it seals from this manifest.
 */
export const STEERING_MANIFEST_MAX_ITEMS = 1_900;

/**
 * How many workspaces the compiled-text cache holds before it drops the
 * oldest entry. One entry is one short string, so the cap is about bounding
 * the map across tenants, not about memory per entry.
 */
export const STEERING_CACHE_MAX_ENTRIES = 1_000;

/** What the bundle carries: the text, and the account of how it was assembled. */
export interface WorkspaceSteering {
  /** `context.system`, or null when nothing steers. */
  text: string | null;
  manifest: SteeringManifest;
}

/**
 * The bundle's steering for these records: the `must` and `should` ones
 * ranked and fitted to the budget, every one accounted for in the manifest,
 * whose list is capped at `STEERING_MANIFEST_MAX_ITEMS` by dropping the
 * oldest cut items. Deterministic in its input set, whatever order it
 * arrives in: the text is part of the bundle etag, and an etag that moved
 * with the database's row order would make every host refetch an unchanged
 * bundle.
 */
export function assembleWorkspaceSteering(
  orgId: string,
  workspaceId: string,
  records: readonly SteeringRecord[],
  budgetTokens: number = CONTEXT_SYSTEM_BUDGET_TOKENS,
): WorkspaceSteering {
  const candidates = records
    .map(recordCandidate)
    .filter((c): c is SteeringCandidate => c !== null);
  const { text, manifest } = assembleSteering(
    { orgId, workspaceId, candidates },
    budgetTokens,
  );
  return { text, manifest: capManifestItems(manifest) };
}

function instantMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * The manifest with its list held to `max` items. Every included item stays;
 * cut items are dropped oldest first (the lower-ranked of two recorded at the
 * same instant goes first), and what is left keeps its rank order. The
 * counts are left alone: `cut` still counts every candidate that was cut, so
 * `cut` less the cut items listed is how many the list leaves out. The
 * schema is strict and has no field of its own for that number.
 */
export function capManifestItems(
  manifest: SteeringManifest,
  max: number = STEERING_MANIFEST_MAX_ITEMS,
): SteeringManifest {
  const over = manifest.items.length - max;
  if (over <= 0) return manifest;
  const dropped = new Set(
    manifest.items
      .map((item, rank) => ({ item, rank }))
      .filter(({ item }) => item.outcome === "cut")
      .sort(
        (a, b) =>
          instantMs(a.item.recorded_at) - instantMs(b.item.recorded_at) ||
          b.rank - a.rank,
      )
      .slice(0, over)
      .map(({ item }) => item),
  );
  return {
    ...manifest,
    items: manifest.items.filter((item) => !dropped.has(item)),
  };
}

interface CachedSteering {
  key: string;
  steering: WorkspaceSteering;
}

const cache = new Map<string, CachedSteering>();

/** Empties the compiled-text cache. For tests, which share one process. */
export function clearSteeringCacheForTests(): void {
  cache.clear();
}

function remember(workspaceKey: string, entry: CachedSteering): void {
  // Re-inserting moves the entry to the end, so the oldest entry is always
  // the map's first key.
  cache.delete(workspaceKey);
  cache.set(workspaceKey, entry);
  while (cache.size > STEERING_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * The workspace's active steering records, assembled for the bundle. One
 * aggregate statement on every call; records are read and assembled only
 * when the workspace's steering version has moved since the last call.
 */
export async function readWorkspaceSteering(
  tx: SteeringTx,
  orgId: string,
  workspaceId: string,
): Promise<WorkspaceSteering> {
  // The plane is part of the cache namespace, not just of the probe. A
  // workspace's identity does not name the database it lives on, and
  // `set_data_plane` moves an organisation between planes: two planes whose
  // migration state, ledger length and steering-record count all agree produce
  // the same key, so without this the first read on the new plane would answer
  // from text compiled against the old one and keep answering until a
  // promotion moved the count.
  const planeKey = await ambientPlaneKey();
  const workspaceKey = `${planeKey}\u0000${orgId}:${workspaceId}`;
  const ready = await versionClassificationReady(tx, planeKey);
  // The probe's answer is part of the key: the migration landing does not move
  // the ledger or the record count, so without it the text compiled from the
  // record row alone would be served on past the window.
  const key = `${ready ? "v" : "r"}:${await readSteeringVersion(tx, orgId, workspaceId, ready)}`;
  const hit = cache.get(workspaceKey);
  if (hit && hit.key === key) return hit.steering;
  const rows = await readSteeringRows(tx, orgId, workspaceId, ready);
  const steering = assembleWorkspaceSteering(
    orgId,
    workspaceId,
    rows.map(classificationOf),
  );
  remember(workspaceKey, { key, steering });
  return steering;
}
