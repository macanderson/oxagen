// Where pull request diffs are kept (ADR-288).
//
// A diff is customer source code, so it goes to a private bucket of its own,
// never through the public-capable blob driver. The bucket is named by a
// deployment setting (`PR_DIFF_BUCKET`, packages/config/src/registry.ts). A
// deployment that names none keeps no diffs: the sync still records the pull
// request, its links, and each head's file list, and marks the revision
// `unconfigured`, so a later capture can fill it once a bucket exists.
//
// Every write is write-once. The key names the head commit, so the same key
// always holds the same bytes, and a retried step that finds its object
// already there treats that as done.
import { createS3ObjectStore, type ObjectStore } from "@oxagen/storage/s3";

/** The one store this deployment keeps diffs in, or null when it names none. */
export type DiffStore = ObjectStore;

let override: DiffStore | null | undefined;
let cached: DiffStore | null | undefined;

/**
 * The deployment's diff store. Read once per process from `PR_DIFF_BUCKET`
 * and `AWS_REGION`; the bucket's own default encryption applies to every
 * object.
 */
export function diffStore(): DiffStore | null {
  if (override !== undefined) return override;
  if (cached !== undefined) return cached;
  const bucket = process.env["PR_DIFF_BUCKET"]?.trim();
  cached =
    bucket === undefined || bucket === ""
      ? null
      : createS3ObjectStore({
          bucket,
          ...(process.env["AWS_REGION"]
            ? { region: process.env["AWS_REGION"] }
            : {}),
        });
  return cached;
}

/** Install a store for a test, or `undefined` to read the environment again. */
export function setDiffStoreForTests(store: DiffStore | null | undefined): void {
  override = store;
  cached = undefined;
}
