// The steering port on the kernel (ARCHITECTURE.md §3.3; #2961): the records
// in force, the proposals and one proposal's Context PR, each a noBillingGate
// kernelRead on the workspace ctx, mapped into its view model and parsed at
// the boundary.
import "server-only";
import { agentMemoryList } from "@oxagen/oxagen/contracts/agent.memory.list";
import { contextPrGet } from "@oxagen/oxagen/contracts/context.pr.get";
import { contextProposalList } from "@oxagen/oxagen/contracts/context.proposal.list";
import { contextRecordsGet } from "@oxagen/oxagen/contracts/context.records.get";
import { contextRecordsList } from "@oxagen/oxagen/contracts/context.records.list";
import { contextSteeringDeliveries } from "@oxagen/oxagen/contracts/context.steering.deliveries";
import { contextSteeringFreshness } from "@oxagen/oxagen/contracts/context.steering.freshness";
import { contextSteeringLayout } from "@oxagen/oxagen/contracts/context.steering.layout";
import { repositoryList } from "@oxagen/oxagen/contracts/repository.list";
import { repositoryTreeGet } from "@oxagen/oxagen/contracts/repository.tree.get";
import { captureError } from "@oxagen/telemetry";
import type { z } from "zod";
import {
  ContextPr,
  MemoryPage,
  OxagenTree,
  ProposalPage,
  type ProposalState,
  RecordDetail,
  RecordPage,
  STEERING_PAGE,
  SteeringFreshness,
  SteeringDeliveries,
  SteeringHub,
  SteeringLayout,
} from "@/data/contracts/steering";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import {
  toContextPr,
  toMemoryPage,
  toOxagenTree,
  toProposalPage,
  toRecordDetail,
  toRecordPage,
  toSteeringFreshness,
  toSteeringLayout,
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
  async memories(ctx, q) {
    const read = await kernelRead(ctx, {
      contract: agentMemoryList,
      input: {
        limit: q.limit,
        offset: 0,
        sort: "createdAt",
        sortDir: "desc",
      },
      page: "steering",
    });
    return read.ok
      ? parsed(MemoryPage, toMemoryPage(read.value), ctx.orgId, "memories")
      : read;
  },
  /**
   * The main repository's `.oxagen/` tree, read from GitHub now: the
   * binding from list_repositories, then get_repository_tree on it. A
   * refusal or failure of either read is the panel's own, and never the
   * shelf's.
   */
  async tree(ctx) {
    const bound = await kernelRead(ctx, {
      contract: repositoryList,
      input: {},
      page: "steering",
    });
    if (!bound.ok) return bound;
    const main = bound.value.repositories.find((repo) => repo.role === "main");
    if (main === undefined) return readOk({ state: "unbound" });
    const tree = await kernelRead(ctx, {
      contract: repositoryTreeGet,
      input: { bindingId: main.bindingId },
      page: "steering",
    });
    return tree.ok
      ? parsed(OxagenTree, toOxagenTree(tree.value), ctx.orgId, "tree")
      : tree;
  },
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
        limit: q.limit ?? STEERING_PAGE,
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
        limit: q.limit ?? STEERING_PAGE,
        offset: q.offset,
        ...(q.lineage === undefined ? {} : { lineageId: q.lineage }),
        ...(q.state === undefined ? {} : { state: q.state }),
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
  async layout(ctx) {
    const read = await kernelRead(ctx, {
      contract: contextSteeringLayout,
      input: {},
      page: "steering",
    });
    return read.ok
      ? parsed(
          SteeringLayout,
          toSteeringLayout(read.value),
          ctx.orgId,
          "layout",
        )
      : read;
  },
  /**
   * The governance mode on the workspace's main repository, and the proposals
   * a person still has to act on.
   *
   * The mode is the binding from list_repositories, then the governance
   * file as get_repository_tree reads it from GitHub now:
   * `steering/governance.toml` in a steering repository,
   * `.oxagen/rules/governance.toml` in a legacy one. Nothing caches the mode (ADR-061 decision 1), so the chip
   * reads the file the Context PR gate reads.
   *
   * The waiting count is the open proposals: candidates with no pull request
   * yet and Context PRs still open. The Proposals list's three filters,
   * Open, Merged and Closed, each read their count here, one row apiece
   * through list_proposals' `state`. The waiting count is null when the open
   * count failed, and the filter counts are null when any of the three
   * failed: a partial set would print a number nobody counted.
   */
  async hub(ctx) {
    const count = (state: ProposalState) =>
      kernelRead(ctx, {
        contract: contextProposalList,
        input: { limit: 1, offset: 0, state },
        page: "steering",
      });
    const governance = async (): Promise<SteeringHub["governance"]> => {
      const bound = await kernelRead(ctx, {
        contract: repositoryList,
        input: {},
        page: "steering",
      });
      if (!bound.ok) return { state: "unread", code: failureCode(bound) };
      const main = bound.value.repositories.find(
        (repo) => repo.role === "main",
      );
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
            path: tree.value.governancePath,
            mode: tree.value.governanceMode,
          }
        : { state: "unread", code: failureCode(tree) };
    };
    const [mode, open, merged, closed] = await Promise.all([
      governance(),
      count("open"),
      count("merged"),
      count("closed"),
    ]);
    const proposalsWaiting = open.ok ? open.value.total : null;
    const states =
      open.ok && merged.ok && closed.ok
        ? {
            open: open.value.total,
            merged: merged.value.total,
            closed: closed.value.total,
          }
        : null;
    return parsed(
      SteeringHub,
      { governance: mode, proposalsWaiting, states },
      ctx.orgId,
      "hub",
    );
  },
};
