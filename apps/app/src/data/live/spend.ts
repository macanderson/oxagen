// The spend port on the kernel (ARCHITECTURE.md §3.3): the cost rollup at one
// level (get_spend), Fleet's spend tiles (get_spend at the model level), one key's drill (get_spend_drill), wasted spend by cause
// (list_waste) and the configured ceilings (get_spend_budget), all
// noBillingGate reads. A refusal passes through as the kernel classified it;
// an answer the view model refuses is reported once as record_unmappable.
import "server-only";
import { billingBudgetGet } from "@oxagen/oxagen/contracts/billing.budget.get";
import { spendDrill } from "@oxagen/oxagen/contracts/spend.drill";
import { spendGet } from "@oxagen/oxagen/contracts/spend.get";
import { spendWasteList } from "@oxagen/oxagen/contracts/spend.waste";
import { captureError } from "@oxagen/telemetry";
import type { z } from "zod";
import {
  FleetSpend,
  SpendBudgets,
  SpendDrill,
  SpendReport,
  SpendWaste,
} from "@/data/contracts/spend";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import {
  toFleetSpend,
  toSpendBudgets,
  toSpendDrill,
  toSpendReport,
  toSpendWaste,
} from "./mappers/spend";

function toView<O, V extends z.ZodType>(
  read: Read<O>,
  view: V,
  map: (out: O) => z.input<V>,
  at: { orgId: string; method: string },
): Read<z.output<V>> {
  if (!read.ok) return read;
  const parsed = view.safeParse(map(read.value));
  if (parsed.success) return readOk(parsed.data);
  captureError({
    error: parsed.error,
    source: "app",
    orgId: at.orgId,
    context: `spend.${at.method} record_unmappable`,
  });
  return readError("record_unmappable", 502);
}

export const spend: DataSource["spend"] = {
  async byGroup(ctx, groupBy, period) {
    const read = await kernelRead(ctx, {
      contract: spendGet,
      input: { period, groupBy },
      page: "spend",
    });
    return toView(read, SpendReport, toSpendReport, {
      orgId: ctx.orgId,
      method: "byGroup",
    });
  },
  async fleet(ctx, period) {
    const read = await kernelRead(ctx, {
      contract: spendGet,
      input: { period, groupBy: "model" },
      page: "spend",
    });
    return toView(read, FleetSpend, toFleetSpend, {
      orgId: ctx.orgId,
      method: "fleet",
    });
  },
  async drill(ctx, kind, key) {
    const read = await kernelRead(ctx, {
      contract: spendDrill,
      input: { kind, key },
      page: "spend",
    });
    return toView(read, SpendDrill, toSpendDrill, {
      orgId: ctx.orgId,
      method: "drill",
    });
  },
  async waste(ctx, period) {
    const read = await kernelRead(ctx, {
      contract: spendWasteList,
      input: { period },
      page: "spend",
    });
    return toView(read, SpendWaste, toSpendWaste, {
      orgId: ctx.orgId,
      method: "waste",
    });
  },
  async budgets(ctx) {
    const read = await kernelRead(ctx, {
      contract: billingBudgetGet,
      input: {},
      page: "spend",
    });
    return toView(read, SpendBudgets, toSpendBudgets, {
      orgId: ctx.orgId,
      method: "budgets",
    });
  },
};
