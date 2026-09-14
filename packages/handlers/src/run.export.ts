// `export_run`: queue the signed evidence bundle for one sealed run (Mission
// Control spec §13.4, App. E; ADR-058).
//
// Guards, each with its negative test: org Owner or Admin (`assertOrgRole`,
// ARCHITECTURE.md §3.2); the run is in the caller's workspace (`not_found`);
// the run is sealed (`conflict`, `run_not_sealed`), because the attestation
// signs the seal. The handler records the job in `evidence.run_exports`
// inside the tenant scope and dispatches the durable function that builds
// the bundle (@oxagen/inngest-functions `evidence.run-export`).
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import {
  runExport,
  type RunExportOutput,
} from "@oxagen/oxagen/contracts/run.export";
import { assertOrgRole } from "@oxagen/iam/org-role";
import { schema, withTenantDb } from "@oxagen/database";
import { eventClient } from "./event-client";
import { runScope } from "./run.list";
import {
  defaultRunReadDeps,
  resolveRun,
  type RunReadDeps,
} from "./lib/run-read";

export const EXPORT_ROLES = ["Owner", "Admin"] as const;

/** The event the export job listens for; its data names the export row. */
export const RUN_EXPORT_EVENT = "evidence/run-export.build";

export interface RunExportEvent {
  name: typeof RUN_EXPORT_EVENT;
  data: {
    exportId: string;
    exportPublicId: string;
    orgId: string;
    workspaceId: string;
    runPublicId: string;
  };
}

export type RunExportDeps = RunReadDeps & {
  insertExport: (row: {
    orgId: string;
    workspaceId: string;
    runPublicId: string;
    requestedByUserId: string;
  }) => Promise<{ id: string; publicId: string }>;
  dispatch: (event: RunExportEvent) => Promise<void>;
};

export function createRunExportHandler(
  deps: RunExportDeps,
): CapabilityHandler<typeof runExport> {
  return async (input, ctx): Promise<RunExportOutput> => {
    await assertOrgRole(ctx, { org: EXPORT_ROLES });
    const scope = runScope(ctx);
    const run = await resolveRun(deps, scope, input.runId);
    if (run.item.status === "live") {
      throw new HandlerError({ code: "conflict", reason: "run_not_sealed" });
    }
    const row = await deps.insertExport({
      ...scope,
      runPublicId: input.runId,
      // assertOrgRole refused a context with no user above.
      requestedByUserId: ctx.userId as string,
    });
    await deps.dispatch({
      name: RUN_EXPORT_EVENT,
      data: {
        exportId: row.id,
        exportPublicId: row.publicId,
        ...scope,
        runPublicId: input.runId,
      },
    });
    return { exportId: row.publicId, status: "queued" };
  };
}

export function defaultRunExportDeps(): RunExportDeps {
  return {
    ...defaultRunReadDeps(),
    insertExport: async (row) => {
      const [inserted] = await withTenantDb((tx) =>
        tx
          .insert(schema.runExports)
          .values({
            orgId: row.orgId,
            workspaceId: row.workspaceId,
            runPublicId: row.runPublicId,
            requestedByUserId: row.requestedByUserId,
            createdByUserId: row.requestedByUserId,
            status: "queued",
          })
          .returning({
            id: schema.runExports.id,
            publicId: schema.runExports.publicId,
          }),
      );
      if (!inserted) throw new Error("run export insert returned no row");
      return inserted;
    },
    dispatch: (event) => eventClient.send(event),
  };
}

export const runExportHandler = createRunExportHandler(defaultRunExportDeps());
