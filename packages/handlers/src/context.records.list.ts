// audit-exempt: read-only — lists the workspace's published steering records; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// list_records (ADR-061): the published registry. Every row now carries a
// real kind and force — a Context PR merge writes them, and since #3302
// publish_context_record requires them too, so no row can steer nothing
// without saying so.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { contextRecordsList } from "@oxagen/oxagen/contracts/context.records.list";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";
import { publishedRecordView } from "./context.steering.view";

export function createListRecordsHandler(
  deps: Pick<SteeringDeps, "store">,
): CapabilityHandler<typeof contextRecordsList> {
  return async (input, ctx) => {
    const { rows, total } = await deps.store.listRecords(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      {
        kind: input.kind,
        sharingScope: input.sharingScope,
        status: input.status,
        lineageId: input.lineageId,
      },
      { limit: input.limit, offset: input.offset },
    );
    return { records: rows.map(publishedRecordView), total };
  };
}

export const listRecordsHandler = createListRecordsHandler(steeringDeps());
