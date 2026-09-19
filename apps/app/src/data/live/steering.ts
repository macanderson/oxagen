// The steering port on the kernel (ARCHITECTURE.md §3.3; #2961): the records
// in force, the proposals and one proposal's Context PR, each a noBillingGate
// kernelRead on the workspace ctx, mapped into its view model and parsed at
// the boundary.
import "server-only";
import { contextPrGet } from "@oxagen/oxagen/contracts/context.pr.get";
import { contextProposalList } from "@oxagen/oxagen/contracts/context.proposal.list";
import { contextRecordsList } from "@oxagen/oxagen/contracts/context.records.list";
import { contextSteeringFreshness } from "@oxagen/oxagen/contracts/context.steering.freshness";
import { captureError } from "@oxagen/telemetry";
import type { z } from "zod";
import {
  ContextPr,
  ProposalPage,
  RecordPage,
  STEERING_PAGE,
  SteeringFreshness,
} from "@/data/contracts/steering";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import {
  toContextPr,
  toProposalPage,
  toRecordPage,
  toSteeringFreshness,
} from "./mappers/steering";

/** The view model parsed from a mapped record, or record_unmappable reported once. */
function parsed<T>(
  schema: z.ZodType<T>,
  record: unknown,
  orgId: string,
  method: string,
): Read<T> {
  const view = schema.safeParse(record);
  if (view.success) return readOk(view.data);
  captureError({
    error: view.error,
    source: "app",
    orgId,
    context: `steering.${method} record_unmappable`,
  });
  return readError("record_unmappable", 502);
}

export const steering: DataSource["steering"] = {
  async records(ctx, q) {
    const read = await kernelRead(ctx, {
      contract: contextRecordsList,
      input: {
        status: "active",
        limit: STEERING_PAGE,
        offset: q.offset,
        ...(q.kind === null ? {} : { kind: q.kind }),
      },
      page: "steering",
    });
    return read.ok
      ? parsed(RecordPage, toRecordPage(read.value), ctx.orgId, "records")
      : read;
  },
  async proposals(ctx, q) {
    const read = await kernelRead(ctx, {
      contract: contextProposalList,
      input: { limit: STEERING_PAGE, offset: q.offset },
      page: "steering",
    });
    return read.ok
      ? parsed(ProposalPage, toProposalPage(read.value), ctx.orgId, "proposals")
      : read;
  },
  async contextPr(ctx, proposalId) {
    const read = await kernelRead(ctx, {
      contract: contextPrGet,
      input: { proposalId },
      page: "steering",
    });
    return read.ok
      ? parsed(ContextPr, toContextPr(read.value), ctx.orgId, "contextPr")
      : read;
  },
  async freshness(ctx) {
    const read = await kernelRead(ctx, {
      contract: contextSteeringFreshness,
      input: {},
      page: "steering",
    });
    return read.ok
      ? parsed(
          SteeringFreshness,
          toSteeringFreshness(read.value),
          ctx.orgId,
          "freshness",
        )
      : read;
  },
};
