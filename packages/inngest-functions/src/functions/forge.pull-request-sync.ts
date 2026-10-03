import { NonRetriableError } from "@oxagen/functions";
import { z } from "zod";

import { createFunction } from "../create-function";
import {
  FORGE_PULL_REQUEST_DIFF_READY_EVENT,
  FORGE_PULL_REQUEST_OBSERVED_EVENT,
} from "../events";
import { forgePullRequestSyncRunner } from "../lib/forge-pull-request-sync-runner";

export { FORGE_PULL_REQUEST_DIFF_READY_EVENT, FORGE_PULL_REQUEST_OBSERVED_EVENT };

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const at = z.string().datetime({ offset: true }).nullable();

const factsSchema = z.object({
  host: z.string().min(1).max(255),
  providerRepositoryId: z.string().min(1).max(64),
  repository: z.string().min(1).max(512),
  number: z.number().int().positive(),
  url: z.string().url().max(2048),
  title: z.string().max(4096).nullable(),
  authorLogin: z.string().max(255).nullable(),
  state: z.enum(["open", "merged", "closed"]),
  draft: z.boolean(),
  baseRef: z.string().max(1024).nullable(),
  headRef: z.string().max(1024).nullable(),
  headSha: z.string().regex(SHA),
  baseSha: z.string().regex(SHA).nullable(),
  mergeBaseSha: z.string().regex(SHA).nullable(),
  mergeCommitSha: z.string().regex(SHA).nullable(),
  mergedAt: at,
  closedAt: at,
  sourceUpdatedAt: at,
});

/** @internal Exported for its unit test. */
export const forgePullRequestSyncSchema = z.object({
  orgId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  provider: z.enum(["github", "gitlab"]),
  repository: z.string().min(1).max(512),
  number: z.number().int().positive(),
  pullKey: z.string().min(1).max(1024),
  facts: factsSchema.optional(),
  link: z
    .object({ rootSessionUuid: z.string().uuid(), opened: z.boolean() })
    .optional(),
});

/**
 * Bring one pull request's stored record up to date (ADR-288).
 *
 *   1. `upsert-pull-request` writes the row from the delivery's facts, or
 *      reads the forge once when the event carried none, and writes the link
 *      to the run that named it and to that run's work orders.
 *   2. `capture-diff` reads the head commit's diff against its merge base and
 *      puts the bytes in object storage under a key that names the head, so a
 *      retry writes the same object. It runs only when that head has no
 *      stored diff, so a label change or a comment reads nothing more.
 *   3. `record-revision` writes the revision row that names the bytes.
 *   4. `diff-ready` tells every reader of `forge/pull-request-diff.ready`.
 *
 * Each step is retried on its own, so a failed database write never reads
 * the forge again. One event per pull request runs at a time, so two pushes
 * in a row never race on the same row, and at most two run at once per
 * workspace, so a burst of deliveries does not spend its forge rate limit at
 * once. The runner is installed by `@oxagen/handlers/register`.
 */
export const [forgePullRequestSync] = createFunction(
  {
    id: "forge/pull-request-sync",
    retries: 4,
    concurrency: [
      { limit: 1, key: "event.data.pullKey" },
      { limit: 2, key: "event.data.workspaceId" },
    ],
  },
  { event: FORGE_PULL_REQUEST_OBSERVED_EVENT },
  async ({ event, step }) => {
    const parsed = forgePullRequestSyncSchema.safeParse(event.data);
    // A malformed event is a sender's bug; retrying it changes nothing.
    if (!parsed.success)
      throw new NonRetriableError(
        `${FORGE_PULL_REQUEST_OBSERVED_EVENT}: malformed event data: ${parsed.error.message}`,
      );
    const request = parsed.data;
    const upserted = await step.run("upsert-pull-request", () =>
      forgePullRequestSyncRunner().upsert(request),
    );
    const { pullRequestId, target } = upserted;
    if (
      upserted.outcome !== "recorded" ||
      pullRequestId === undefined ||
      target === undefined ||
      !upserted.needsCapture
    )
      return { upserted };
    const captured = await step.run("capture-diff", () =>
      forgePullRequestSyncRunner().capture(request, pullRequestId, target),
    );
    const recorded = await step.run("record-revision", () =>
      forgePullRequestSyncRunner().record(
        request,
        pullRequestId,
        target,
        captured,
      ),
    );
    if (recorded.newlyStored)
      await step.sendEvent("diff-ready", {
        name: FORGE_PULL_REQUEST_DIFF_READY_EVENT,
        id: `forge-diff-ready:${recorded.revisionId}`,
        data: {
          orgId: request.orgId,
          workspaceId: request.workspaceId,
          pullRequestId,
          revisionId: recorded.revisionId,
          provider: request.provider,
          repository: request.repository,
          number: request.number,
          headSha: target.headSha,
          diffKey: captured.diffKey,
          diffSha256: captured.diffSha256,
        },
      });
    return {
      upserted,
      diffStatus: recorded.diffStatus,
      newlyStored: recorded.newlyStored,
    };
  },
);
