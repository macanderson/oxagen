// The changes port on the kernel (ARCHITECTURE.md §3.3; ADR-292): a scope's
// change set and one revision's diff, each a noBillingGate kernelRead on the
// workspace ctx, mapped into its view model and parsed at the boundary.
//
// The read names the page that asked, so a denial names that page's
// permission: a run or an issue is read on the Run page, and a work item or a
// work order on the work item page. A revision's diff has no scope, and the
// contract's domain is `run`, so it reads as the Run page's.
import "server-only";
import { changeSetGet } from "@oxagen/oxagen/contracts/forge.changes.get";
import { revisionDiffGet } from "@oxagen/oxagen/contracts/forge.revision.diff.get";
import { captureError } from "@oxagen/telemetry";
import type { z } from "zod";
import {
  ChangeSet,
  type ChangeSetScope,
  RevisionDiff,
} from "@/data/contracts/changes";
import type { DataSource } from "@/data/ports";
import { type PageKey, type Read, readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import { toChangeSet, toRevisionDiff } from "./mappers/changes";

const PAGE_OF: Record<ChangeSetScope, PageKey> = {
  run: "run",
  issue: "run",
  work_item: "work",
  work_order: "work",
};

/** The mapped value parsed at the boundary; a record the view refuses is `record_unmappable`, reported once. */
function view<S extends z.ZodType>(
  orgId: string,
  schema: S,
  mapped: z.input<S>,
  read: string,
): Read<z.output<S>> {
  const parsed = schema.safeParse(mapped);
  if (parsed.success) return readOk(parsed.data);
  captureError({
    error: parsed.error,
    source: "app",
    orgId,
    context: `${read} record_unmappable`,
  });
  return readError("record_unmappable", 502);
}

export const changes: DataSource["changes"] = {
  async changeSet(ctx, scope, id) {
    const read = await kernelRead(ctx, {
      contract: changeSetGet,
      input: { scope, id },
      page: PAGE_OF[scope],
    });
    if (!read.ok) return read;
    return view(ctx.orgId, ChangeSet, toChangeSet(read.value), "changes.changeSet");
  },
  async revisionDiff(ctx, revisionId, paths) {
    const read = await kernelRead(ctx, {
      contract: revisionDiffGet,
      input: {
        revisionId,
        ...(paths === undefined ? {} : { paths: [...paths] }),
      },
      page: "run",
    });
    if (!read.ok) return read;
    return view(
      ctx.orgId,
      RevisionDiff,
      toRevisionDiff(read.value),
      "changes.revisionDiff",
    );
  },
};
