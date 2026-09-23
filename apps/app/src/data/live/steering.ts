// The steering port on the kernel (ARCHITECTURE.md §3.3; #2961): the records
// in force, the proposals and one proposal's Context PR, each a noBillingGate
// kernelRead on the workspace ctx, mapped into its view model and parsed at
// the boundary.
import "server-only";
import { contextPrGet } from "@oxagen/oxagen/contracts/context.pr.get";
import { contextProposalList } from "@oxagen/oxagen/contracts/context.proposal.list";
import { contextRecordsGet } from "@oxagen/oxagen/contracts/context.records.get";
import { contextRecordsList } from "@oxagen/oxagen/contracts/context.records.list";
import { contextSteeringDeliveries } from "@oxagen/oxagen/contracts/context.steering.deliveries";
import { contextSteeringFreshness } from "@oxagen/oxagen/contracts/context.steering.freshness";
import { repositoryList } from "@oxagen/oxagen/contracts/repository.list";
import { repositoryTreeGet } from "@oxagen/oxagen/contracts/repository.tree.get";
import { captureError } from "@oxagen/telemetry";
import type { z } from "zod";
import {
  ContextPr,
  ProposalPage,
  RecordDetail,
  RecordPage,
  STEERING_PAGE,
  SteeringFreshness,
  SteeringDeliveries,
  SteeringHub,
} from "@/data/contracts/steering";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import {
  toContextPr,
  toProposalPage,
  toRecordDetail,
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

/**
 * The capability names a cut record `recordId`. The view model carries it as
 * `recordRef`, because it is the manifest's own key for the record and not a
 * public id Oxagen minted (INV-11). Output of the wrong shape passes through
 * untouched, so the parse reports it rather than this throwing.
 */
function withRecordRefs(value: unknown): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    !("undelivered" in value) ||
    !Array.isArray(value.undelivered)
  ) {
    return value;
  }
  return {
    ...value,
    undelivered: value.undelivered.map((row: unknown) => {
      if (typeof row !== "object" || row === null || !("recordId" in row)) {
        return row;
      }
      const { recordId, ...rest } = row;
      return { ...rest, recordRef: recordId };
    }),
  };
}

/** A failed read's code, as the hub prints it beside a mode nobody read. */
function failureCode(read: Exclude<Read<unknown>, { ok: true }>): string {
  switch (read.reason) {
    case "denied":
      return "denied";
    case "pending_approval":
      return "pending_approval";
    case "error":
      return read.code;
  }
}

export const steering: DataSource["steering"] = {
  async deliveries(ctx) {
    const read = await kernelRead(ctx, {
      contract: contextSteeringDeliveries,
      input: { days: 7, limit: 50 },
      page: "steering",
    });
    return read.ok
      ? parsed(
          SteeringDeliveries,
          withRecordRefs(read.value),
          ctx.orgId,
          "deliveries",
        )
      : read;
  },
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
  async record(ctx, lineage) {
    const read = await kernelRead(ctx, {
      contract: contextRecordsGet,
      input: { recordId: lineage },
      page: "steering",
    });
    if (!read.ok) return read;
    // The route names a lineage, so the answer is the published record on it.
    // An append carries a lineage too, but it is read by its own `cta_` id on
    // the run that wrote it, and it is not in force: answering this route with
    // one would show an unpublished sentence as a governed rule.
    if (read.value.source !== "published") return readError("not_found", 404);
    return parsed(
      RecordDetail,
      toRecordDetail(read.value),
      ctx.orgId,
      "record",
    );
  },
  async proposals(ctx, q) {
    const read = await kernelRead(ctx, {
      contract: contextProposalList,
      input: {
        limit: STEERING_PAGE,
        offset: q.offset,
        ...(q.lineage === undefined ? {} : { lineageId: q.lineage }),
      },
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
  /**
   * The governance mode on the workspace's main repository, and the proposals
   * a person still has to act on.
   *
   * The mode is the binding from list_repositories, then
   * `.oxagen/rules/governance.toml` as get_repository_tree reads it from
   * GitHub now. Nothing caches the mode (ADR-061 decision 1), so the chip
   * reads the file the Context PR gate reads.
   *
   * The waiting count is every proposal, less the merged and the dismissed.
   * list_proposals narrows by one status at a time, so this is three counts
   * of one row each rather than five. It is null when any count failed: a
   * partial difference would print a number nobody counted.
   */
  async hub(ctx) {
    const count = (status?: "merged" | "rejected") =>
      kernelRead(ctx, {
        contract: contextProposalList,
        input: { limit: 1, offset: 0, ...(status ? { status } : {}) },
        page: "steering",
      });
    const governance = async (): Promise<SteeringHub["governance"]> => {
      const bound = await kernelRead(ctx, {
        contract: repositoryList,
        input: {},
        page: "steering",
      });
      if (!bound.ok) return { state: "unread", code: failureCode(bound) };
      const main = bound.value.repositories.find((repo) => repo.role === "main");
      if (main === undefined) return { state: "unbound" };
      const tree = await kernelRead(ctx, {
        contract: repositoryTreeGet,
        input: { bindingId: main.bindingId },
        page: "steering",
      });
      return tree.ok
        ? {
            state: "read",
            repository: tree.value.fullName,
            mode: tree.value.governanceMode,
          }
        : { state: "unread", code: failureCode(tree) };
    };
    const [mode, all, merged, rejected] = await Promise.all([
      governance(),
      count(),
      count("merged"),
      count("rejected"),
    ]);
    const proposalsWaiting =
      all.ok && merged.ok && rejected.ok
        ? Math.max(
            0,
            all.value.total - merged.value.total - rejected.value.total,
          )
        : null;
    return parsed(
      SteeringHub,
      { governance: mode, proposalsWaiting },
      ctx.orgId,
      "hub",
    );
  },
};
