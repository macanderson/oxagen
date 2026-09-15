// audit-exempt: read-only — answers one published or appended record; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// get_record (ADR-061): a `cta_` id reads the append; anything else reads the
// registry by public id or lineage.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import {
  contextRecordsGet,
  type ContextRecordsGetOutput,
} from "@oxagen/oxagen/contracts/context.records.get";
import type {
  AppendKind,
  PublishedSharingScope,
} from "@oxagen/oxagen/contracts/context.steering.shared";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";
import { publishedRecordView } from "./context.steering.view";

export function createGetRecordHandler(
  deps: Pick<SteeringDeps, "store">,
): CapabilityHandler<typeof contextRecordsGet> {
  return async (input, ctx): Promise<ContextRecordsGetOutput> => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    if (input.recordId.startsWith("cta_")) {
      const row = await deps.store.findAppend(scope, input.recordId);
      if (!row) throw notFound(input.recordId);
      const proposal = row.proposalId
        ? await deps.store.findProposalById(row.proposalId)
        : null;
      return {
        source: "appended",
        record: {
          id: row.publicId,
          kind: row.kind as AppendKind,
          lineageId: row.lineageId,
          statement: row.statement,
          sharingScope: row.sharingScope as
            | PublishedSharingScope
            | "user"
            | "organization",
          recordHash: row.recordHash,
          sourceRefs: row.sourceRefs,
          evidenceLinks: row.evidenceLinks,
          proposalId: proposal?.publicId ?? null,
          createdAt: row.createdAt.toISOString(),
        },
      };
    }
    const found = await deps.store.findRecord(scope, input.recordId);
    if (!found) throw notFound(input.recordId);
    return {
      source: "published",
      record: publishedRecordView(found.record),
      versions: found.versions.map((v) => ({
        id: v.publicId,
        version: v.version,
        checksum: v.checksum,
        isLatest: v.isLatest,
        publishedAt: v.publishedAt?.toISOString() ?? null,
      })),
      proposalId: found.publishedBy?.proposalPublicId ?? null,
      prUrl: found.publishedBy?.prUrl ?? null,
    };
  };
}

function notFound(id: string): HandlerError {
  return new HandlerError({
    code: "not_found",
    reason: "record_not_found",
    message: `No record ${id} in this workspace`,
  });
}

export const getRecordHandler = createGetRecordHandler(steeringDeps());
