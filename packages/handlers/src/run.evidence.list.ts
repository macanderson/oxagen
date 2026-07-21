import type { CapabilityHandler } from "@oxagen/oxagen";
import { runEvidenceList } from "@oxagen/oxagen/contracts/run.evidence.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, count, desc, eq, inArray, lt } from "drizzle-orm";

// Mirrors run_evidence_manifests.evidence_authority CHECK + the contract output
// enum. The column is `text`; narrow it to the union the output schema expects.
type RunEvidenceAuthority =
  | "runner_observed"
  | "provider_observed"
  | "client_attested"
  | "inferred";

/**
 * list_run_evidence handler — tenant-scoped, keyset-paginated listing of
 * RunEvidenceManifestV1 summaries, newest first. Postgres-only: change/frame
 * counts are derived from the child tables, never from ClickHouse.
 *
 * Keyset pagination fetches limit+1 rows to detect a next page; nextCursor is
 * the created_at of the last returned row (pass back as `cursor`).
 */
export const runEvidenceListHandler: CapabilityHandler<
  typeof runEvidenceList
> = async (input, _ctx) => {
  return withTenantDb(async (tx) => {
    const filters = and(
      input.runId
        ? eq(schema.runEvidenceManifests.runId, input.runId)
        : undefined,
      input.repositoryId
        ? eq(
            schema.runEvidenceManifests.checkoutRepositoryId,
            input.repositoryId,
          )
        : undefined,
      input.cursor
        ? lt(schema.runEvidenceManifests.createdAt, new Date(input.cursor))
        : undefined,
    );

    // Fetch one extra row to decide whether a further page exists.
    const rows = await tx
      .select({
        internalId: schema.runEvidenceManifests.id,
        publicId: schema.runEvidenceManifests.publicId,
        runId: schema.runEvidenceManifests.runId,
        attemptId: schema.runEvidenceManifests.attemptId,
        evidenceAuthority: schema.runEvidenceManifests.evidenceAuthority,
        manifestDigest: schema.runEvidenceManifests.manifestDigest,
        createdAt: schema.runEvidenceManifests.createdAt,
      })
      .from(schema.runEvidenceManifests)
      .where(filters)
      .orderBy(desc(schema.runEvidenceManifests.createdAt))
      .limit(input.limit + 1);

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;

    // Derive change/frame counts from the child tables for the page only.
    const manifestIds = page.map((r) => r.internalId);
    const changeCounts = new Map<string, number>();
    const frameCounts = new Map<string, number>();
    if (manifestIds.length > 0) {
      const changeRows = await tx
        .select({
          manifestId: schema.runEvidenceChanges.manifestId,
          n: count(),
        })
        .from(schema.runEvidenceChanges)
        .where(inArray(schema.runEvidenceChanges.manifestId, manifestIds))
        .groupBy(schema.runEvidenceChanges.manifestId);
      for (const r of changeRows) changeCounts.set(r.manifestId, Number(r.n));

      const frameRows = await tx
        .select({
          manifestId: schema.runContextFrames.manifestId,
          n: count(),
        })
        .from(schema.runContextFrames)
        .where(inArray(schema.runContextFrames.manifestId, manifestIds))
        .groupBy(schema.runContextFrames.manifestId);
      for (const r of frameRows) frameCounts.set(r.manifestId, Number(r.n));
    }

    return {
      manifests: page.map((r) => ({
        id: r.publicId,
        runId: r.runId,
        attemptId: r.attemptId,
        evidenceAuthority: r.evidenceAuthority as RunEvidenceAuthority,
        manifestDigest: r.manifestDigest,
        createdAt: r.createdAt.toISOString(),
        changeCount: changeCounts.get(r.internalId) ?? 0,
        frameCount: frameCounts.get(r.internalId) ?? 0,
      })),
      nextCursor: hasMore
        ? (page[page.length - 1]?.createdAt.toISOString() ?? null)
        : null,
    };
  });
};
