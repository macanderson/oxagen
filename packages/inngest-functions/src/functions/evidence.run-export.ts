// evidence.run-export.ts — builds the signed evidence bundle `export_run`
// queued (Mission Control spec §13.4; App. E; ADR-058).
//
// Triggered by `evidence/run-export.build`. The handler inserted the
// `evidence.run_exports` row as `queued` before dispatching. Steps:
//   1. mark the row `building`;
//   2. read the run's sealed segments in its tenant scope, sign one
//      attestation per sealed attempt with the deployment's attester key,
//      zip the bundle and write it once to the organisation's evidence store;
//   3. mark the row `ready` with where the bundle landed, its digest and
//      size, the Merkle root and the frame count.
// The on-failure companion marks the row `failed` with the reason once
// retries are exhausted, so Audit › exports never shows an eternally
// building job. A deployment with no attester key fails at once: an
// unsigned export is not the bundle the capability promises.
import { schema, withTenantDb } from "@oxagen/database";
import { ATTESTER_KEY_ENV } from "@oxagen/run-ledger/attester-key";
import { evidenceStore } from "@oxagen/run-ledger/evidence-store";
import { attesterKeyFromPem } from "@oxagen/tacho";
import { runInTenantScope } from "@oxagen/tenancy";
import { NonRetriableError } from "@oxagen/functions";
import { and, eq } from "drizzle-orm";
import { createFunction } from "../create-function";
import { logger } from "../logger";
import { readSealedSegments, resolveRunRecord } from "../lib/run-record";
import { buildRunExportBundle } from "../lib/run-export-bundle";

export const RUN_EXPORT_EVENT = "evidence/run-export.build";

/** The same Ed25519 key that signs policy bundles and seals attests exports. */
export { ATTESTER_KEY_ENV };

interface RunExportEventData {
  exportId: string;
  exportPublicId: string;
  orgId: string;
  workspaceId: string;
  runPublicId: string;
}

async function setStatus(
  data: Pick<RunExportEventData, "exportId" | "orgId" | "workspaceId">,
  values: Partial<typeof schema.runExports.$inferInsert>,
): Promise<void> {
  await runInTenantScope(
    { orgId: data.orgId, workspaceId: data.workspaceId },
    () =>
      withTenantDb((tx) =>
        tx
          .update(schema.runExports)
          .set({ ...values, updatedAt: new Date() })
          .where(
            and(
              eq(schema.runExports.id, data.exportId),
              eq(schema.runExports.orgId, data.orgId),
            ),
          ),
      ),
  );
}

export const [evidenceRunExport, evidenceRunExportOnFailure] = createFunction(
  {
    id: "evidence.run-export",
    retries: 2,
    concurrency: { limit: 2, key: "event.data.orgId" },
    onFailure: async ({ event, step }) => {
      const failure = event.data as {
        event?: { data?: Partial<RunExportEventData> };
        error?: unknown;
      };
      const data = failure.event?.data;
      if (!data?.exportId || !data.orgId || !data.workspaceId) return;
      const message =
        typeof failure.error === "object" &&
        failure.error !== null &&
        "message" in failure.error
          ? String((failure.error as { message: unknown }).message)
          : String(failure.error ?? "unknown error");
      await step.run("mark-export-failed", () =>
        setStatus(data as RunExportEventData, {
          status: "failed",
          error: message,
        }),
      );
      logger.error(
        { exportId: data.exportId, error: message },
        "evidence.run-export: marked failed",
      );
    },
  },
  { event: RUN_EXPORT_EVENT },
  async ({ event, step }) => {
    const data = event.data as unknown as RunExportEventData;
    const scope = { orgId: data.orgId, workspaceId: data.workspaceId };

    await step.run("mark-building", () =>
      setStatus(data, { status: "building" }),
    );

    const built = await step.run("build-and-upload", async () => {
      const pem = process.env[ATTESTER_KEY_ENV];
      if (!pem) {
        throw new NonRetriableError(
          `no attester key: ${ATTESTER_KEY_ENV} is unset, so the export cannot be signed`,
        );
      }
      const key = attesterKeyFromPem(pem.replace(/\\n/g, "\n"));
      const record = await resolveRunRecord(scope, data.runPublicId);
      if (!record) {
        throw new NonRetriableError(
          `run ${data.runPublicId} is not in the export's workspace`,
        );
      }
      const segments = await readSealedSegments(scope, record);
      if (segments.length === 0) {
        throw new NonRetriableError(
          `run ${data.runPublicId} has no sealed attempt to export`,
        );
      }
      const bundle = buildRunExportBundle({
        runId: data.runPublicId,
        source: record.source,
        segments,
        key,
        now: new Date(),
      });
      const { ref } = await evidenceStore().putBundle({
        scope,
        exportId: data.exportPublicId,
        digest: bundle.digest,
        bytes: bundle.bytes,
      });
      return {
        ref,
        digest: bundle.digest,
        bytes: bundle.bytes.byteLength,
        merkleRoot: bundle.manifest.merkle_root,
        frameCount: bundle.manifest.frame_count,
      };
    });

    await step.run("mark-ready", () =>
      setStatus(data, {
        status: "ready",
        bundleRef: built.ref,
        bundleDigest: built.digest,
        bundleBytes: built.bytes,
        merkleRoot: built.merkleRoot,
        frameCount: built.frameCount,
        completedAt: new Date(),
      }),
    );

    logger.info(
      {
        exportId: data.exportId,
        runPublicId: data.runPublicId,
        frameCount: built.frameCount,
      },
      "evidence.run-export: bundle ready",
    );
    return { exportId: data.exportId, bundleRef: built.ref };
  },
);
