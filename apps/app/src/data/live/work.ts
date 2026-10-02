// The work port on the kernel (ARCHITECTURE.md §3.3): the Work pages' six
// reads, each a noBillingGate read of the work records mapped into its view
// model. list_work_items, get_work_item, list_work_targets and
// get_work_outcomes are P1-05's (#5163). list_work_collectors and
// get_work_priorities are P1-03's (#5103).
//
// The server decides each item's status and what it waits for, and reads no
// GitHub on a page load: the checks are what Oxagen last recorded. A record
// the view refuses is `record_unmappable`, reported once, never a partial page.
import "server-only";
import { workCollectorsList } from "@oxagen/oxagen/contracts/work.collectors.list";
import { workItemGet } from "@oxagen/oxagen/contracts/work.item.get";
import { workItemsList } from "@oxagen/oxagen/contracts/work.items.list";
import { workOutcomesGet } from "@oxagen/oxagen/contracts/work.outcomes.get";
import { workPrioritiesGet } from "@oxagen/oxagen/contracts/work.priorities.get";
import { workTargetsList } from "@oxagen/oxagen/contracts/work.targets.list";
import { captureError } from "@oxagen/telemetry";
import type { z } from "zod";
import {
  WorkCollectorList,
  WorkItemDetail,
  WorkItemList,
  WorkOutcomes,
  WorkPriorities,
  WorkTargetList,
} from "@/data/contracts/work";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import { toWorkItemDetail } from "./mappers/work-item";
import {
  toWorkCollectorList,
  toWorkItemList,
  toWorkOutcomes,
  toWorkPriorities,
  toWorkTargetList,
} from "./mappers/work-list";

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

export const work: DataSource["work"] = {
  async list(ctx) {
    const read = await kernelRead(ctx, {
      contract: workItemsList,
      input: { limit: 500 },
      page: "work",
    });
    if (!read.ok) return read;
    return view(ctx.orgId, WorkItemList, toWorkItemList(read.value), "work.list");
  },
  async get(ctx, item) {
    const read = await kernelRead(ctx, {
      contract: workItemGet,
      input: { item },
      page: "work",
    });
    if (!read.ok) return read;
    return view(ctx.orgId, WorkItemDetail, toWorkItemDetail(read.value), "work.get");
  },
  async targets(ctx) {
    const read = await kernelRead(ctx, {
      contract: workTargetsList,
      input: {},
      page: "work",
    });
    if (!read.ok) return read;
    return view(ctx.orgId, WorkTargetList, toWorkTargetList(read.value), "work.targets");
  },
  async outcomes(ctx) {
    const read = await kernelRead(ctx, {
      contract: workOutcomesGet,
      input: { days: 30 },
      page: "work",
    });
    if (!read.ok) return read;
    return view(ctx.orgId, WorkOutcomes, toWorkOutcomes(read.value), "work.outcomes");
  },
  async collectors(ctx) {
    const read = await kernelRead(ctx, {
      contract: workCollectorsList,
      input: {},
      page: "work",
    });
    if (!read.ok) return read;
    return view(
      ctx.orgId,
      WorkCollectorList,
      toWorkCollectorList(read.value),
      "work.collectors",
    );
  },
  async priorities(ctx) {
    const read = await kernelRead(ctx, {
      contract: workPrioritiesGet,
      input: {},
      page: "work",
    });
    if (!read.ok) return read;
    return view(ctx.orgId, WorkPriorities, toWorkPriorities(read.value), "work.priorities");
  },
};
