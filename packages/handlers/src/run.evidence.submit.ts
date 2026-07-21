import type { CapabilityHandler } from "@oxagen/oxagen";
import { runEvidenceSubmit } from "@oxagen/oxagen/contracts/run.evidence.submit";
import { contentHashOf, schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";

/**
 * submit_run_evidence handler — ingest one immutable RunEvidenceManifestV1.
 *
 * - manifest_digest = sha256(canonical JSON of the CLIENT INPUT only). It
 *   excludes every server-stamped field (evidence_authority, created_at,
 *   public_id) so an identical resubmission produces an identical digest and
 *   dedupes. `contentHashOf` canonicalizes (keys sorted recursively, array order
 *   preserved) then sha256s.
 * - evidence_authority is HARD-STAMPED 'client_attested' — launch invariant 4:
 *   no client can author runner_observed/provider_observed evidence. The input
 *   carries no authority field to override.
 * - Idempotent: onConflictDoNothing on (org_id, run_id, attempt_id,
 *   manifest_digest) (UNIQUE NULLS NOT DISTINCT). A conflict returns the existing
 *   manifest with deduplicated:true and writes NO child rows — the ledger is
 *   append-only and never overwritten.
 * - Normalized run_evidence_changes + run_context_frames rows are written in the
 *   SAME transaction as the manifest, only on a fresh insert.
 */
export const runEvidenceSubmitHandler: CapabilityHandler<
  typeof runEvidenceSubmit
> = async (input, ctx) => {
  // Pure function of client input — the immutable content identity of the run.
  const manifestDigest = contentHashOf(
    input as unknown as Record<string, unknown>,
  );

  // Launch invariant 4 — a client upload is attested-but-unverified, always.
  const evidenceAuthority = "client_attested" as const;

  const snap = input.localCheckoutSnapshot;
  const changes = input.changes ?? [];
  const frames = input.context?.frames ?? [];

  return withTenantDb(async (tx) => {
    const insertedRows = await tx
      .insert(schema.runEvidenceManifests)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        createdByUserId: ctx.userId ?? null,
        runId: input.runId,
        attemptId: input.attemptId ?? null,
        initiatingPrincipalId: input.principals.initiatingPrincipalId,
        agentPrincipalId: input.principals.agentPrincipalId ?? null,
        agentVersionId: input.agentVersionId ?? null,
        authorizationSnapshotId: input.authorizationSnapshotId ?? null,
        checkoutRepositoryId: snap.repositoryId ?? null,
        baseCommitSha: snap.baseCommitSha,
        headCommitSha: snap.headCommitSha ?? null,
        headTreeSha: snap.headTreeSha ?? null,
        dirtyPatchDigest: snap.dirtyPatchDigest ?? null,
        untrackedManifestDigest: snap.untrackedManifestDigest ?? null,
        graphGenerationId: snap.graphGenerationId ?? null,
        graphSchemaVersion: snap.graphSchemaVersion ?? null,
        extractorVersion: snap.extractorVersion ?? null,
        indexedRootDigest: snap.indexedRootDigest ?? null,
        checkoutCompletedAt: snap.completedAt
          ? new Date(snap.completedAt)
          : null,
        freshnessStatus: snap.freshnessStatus ?? null,
        evidenceAuthority,
        manifestDigest,
        payload: input,
      })
      .onConflictDoNothing({
        target: [
          schema.runEvidenceManifests.orgId,
          schema.runEvidenceManifests.runId,
          schema.runEvidenceManifests.attemptId,
          schema.runEvidenceManifests.manifestDigest,
        ],
      })
      .returning({
        id: schema.runEvidenceManifests.id,
        publicId: schema.runEvidenceManifests.publicId,
      });

    const inserted = insertedRows[0];

    // Conflict → an identical manifest already exists. Return it verbatim; the
    // immutable ledger is never rewritten and its children already exist.
    if (!inserted) {
      const [existing] = await tx
        .select({ publicId: schema.runEvidenceManifests.publicId })
        .from(schema.runEvidenceManifests)
        .where(
          and(
            eq(schema.runEvidenceManifests.orgId, ctx.orgId),
            eq(schema.runEvidenceManifests.runId, input.runId),
            input.attemptId != null
              ? eq(schema.runEvidenceManifests.attemptId, input.attemptId)
              : isNull(schema.runEvidenceManifests.attemptId),
            eq(schema.runEvidenceManifests.manifestDigest, manifestDigest),
          ),
        )
        .limit(1);

      return {
        manifestId: existing?.publicId ?? "",
        manifestDigest,
        deduplicated: true,
      };
    }

    // Fresh insert → normalize the changed-file and context-frame evidence into
    // their child tables in the same transaction.
    if (changes.length > 0) {
      await tx.insert(schema.runEvidenceChanges).values(
        changes.map((c) => ({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          createdByUserId: ctx.userId ?? null,
          manifestId: inserted.id,
          repositoryId: c.repositoryId ?? null,
          pathLocator: c.pathLocator,
          changeKind: c.changeKind,
          beforeDigest: c.beforeDigest ?? null,
          afterDigest: c.afterDigest ?? null,
          codeScopeId: c.codeScopeId ?? null,
          domainSlug: c.domainSlug ?? null,
        })),
      );
    }

    if (frames.length > 0) {
      await tx.insert(schema.runContextFrames).values(
        frames.map((f) => ({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          createdByUserId: ctx.userId ?? null,
          manifestId: inserted.id,
          providerId: f.providerId,
          frameId: f.frameId,
          uri: f.uri ?? null,
          canonicalContentDigest: f.canonicalContentDigest,
          localGraphGenerationId: f.localGraphGenerationId ?? null,
          authorizationDecisionId: f.authorizationDecisionId ?? null,
          retentionMode: f.retentionMode,
          tokenCost: f.tokenCost ?? null,
        })),
      );
    }

    return {
      manifestId: inserted.publicId,
      manifestDigest,
      deduplicated: false,
    };
  });
};
