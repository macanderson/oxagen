// audit-exempt: the certification queue is written by the forge sync's event for each stored diff; no person authors a pending row.
//
// The witness's queue (ADR-294). Every revision whose diff is stored gets one
// `forge.revision_certifications` row, which starts `pending`. The witness
// (ADR-064) will decide each row: `certified` when the change meets its
// definition of done, `rejected` when it does not. It is not built, so
// `certifyRevision` leaves every row pending and says why. The witness plugs
// in there, and nothing that queues a row changes.
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import type {
  ForgeCertificationOutcome,
  ForgeCertificationQueueOutcome,
  ForgeCertificationState,
  ForgeRevisionCertificationRequest,
  ForgeRevisionCertificationRunner,
} from "@oxagen/inngest-functions/forge-revision-certification-runner";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq } from "drizzle-orm";
import type { Scope } from "./store";

const revisions = schema.forgePullRequestRevisions;
const certifications = schema.forgeRevisionCertifications;

/**
 * Write a stored revision's pending row, once. A second call for the same
 * revision writes nothing and answers the row it finds, in whatever state
 * the witness left it. A revision the scope does not hold on that pull
 * request answers `gone`, because it was deleted since the event was sent.
 */
export async function queueCertification(
  tx: Pick<Tx, "insert" | "select">,
  scope: Scope,
  request: Pick<ForgeRevisionCertificationRequest, "pullRequestId" | "revisionId">,
): Promise<ForgeCertificationQueueOutcome> {
  const [revision] = await tx
    .select({ id: revisions.id })
    .from(revisions)
    .where(
      and(
        eq(revisions.orgId, scope.orgId),
        eq(revisions.workspaceId, scope.workspaceId),
        eq(revisions.id, request.revisionId),
        eq(revisions.pullRequestId, request.pullRequestId),
      ),
    )
    .limit(1);
  if (revision === undefined)
    return { outcome: "gone", certificationId: null, state: null };
  const [written] = await tx
    .insert(certifications)
    .values({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      pullRequestId: request.pullRequestId,
      revisionId: request.revisionId,
    })
    .onConflictDoNothing({ target: certifications.revisionId })
    .returning({ publicId: certifications.publicId });
  if (written !== undefined)
    return {
      outcome: "queued",
      certificationId: String(written.publicId),
      state: "pending",
    };
  const [held] = await tx
    .select({ publicId: certifications.publicId, state: certifications.state })
    .from(certifications)
    .where(
      and(
        eq(certifications.orgId, scope.orgId),
        eq(certifications.workspaceId, scope.workspaceId),
        eq(certifications.revisionId, request.revisionId),
      ),
    )
    .limit(1);
  // The unique index refused the insert, so the row exists. One that is not
  // in this scope would mean a revision id shared across workspaces, which
  // the revision lookup above has already ruled out.
  if (held === undefined)
    throw new Error(
      `forge.revision_certifications: revision ${request.revisionId} has a row outside its scope`,
    );
  return {
    outcome: "existing",
    certificationId: String(held.publicId),
    state: held.state as ForgeCertificationState,
  };
}

/**
 * Ask the witness for a verdict on one pending row. The witness is not built
 * (ADR-064), so the row stays pending. When it exists, this function reads
 * the stored diff by `diffKey`, checks it against `diffSha256`, decides, and
 * writes the row's state, `decided_at`, and verdict.
 */
export function certifyRevision(
  _request: ForgeRevisionCertificationRequest,
  _certificationId: string,
): Promise<ForgeCertificationOutcome> {
  return Promise.resolve({ state: "pending", reason: "witness_not_built" });
}

/** The runner `@oxagen/handlers/register` installs: each step in the event's tenant scope. */
export function forgeCertificationRunner(): ForgeRevisionCertificationRunner {
  const scoped = <T>(
    request: ForgeRevisionCertificationRequest,
    fn: () => Promise<T>,
  ) =>
    runInTenantScope(
      { orgId: request.orgId, workspaceId: request.workspaceId },
      fn,
    );
  return {
    queue: (request) =>
      scoped(request, () =>
        withTenantDb((tx) =>
          queueCertification(
            tx,
            { orgId: request.orgId, workspaceId: request.workspaceId },
            request,
          ),
        ),
      ),
    certify: (request, certificationId) =>
      scoped(request, () => certifyRevision(request, certificationId)),
  };
}
