// The spend port on the kernel (ARCHITECTURE.md §3.3): the cost rollup at one
// level (get_spend), Fleet's spend tiles (get_spend at the model level), one key's drill (get_spend_drill), wasted spend by cause
// (list_waste), the configured ceilings (get_spend_budget), the price book
// (list_price_entries) and the models it cannot price
// (list_unpriced_models), all noBillingGate reads. A refusal passes through as the kernel classified it;
// an answer the view model refuses is reported once as record_unmappable.
import "server-only";
import { billingBudgetGet } from "@oxagen/oxagen/contracts/billing.budget.get";
import { costPriceEntryList } from "@oxagen/oxagen/contracts/cost.price_entry.list";
import { costUnpricedModelList } from "@oxagen/oxagen/contracts/cost.unpriced_model.list";
import { findingEvidenceGet } from "@oxagen/oxagen/contracts/finding.evidence.get";
import { findingList } from "@oxagen/oxagen/contracts/finding.list";
import { spendDrill } from "@oxagen/oxagen/contracts/spend.drill";
import { spendGet } from "@oxagen/oxagen/contracts/spend.get";
import { spendWasteList } from "@oxagen/oxagen/contracts/spend.waste";
import { tachoSessionPolicyRead } from "@oxagen/oxagen/contracts/tacho.session_policy.read";
import { captureError } from "@oxagen/telemetry";
import type { z } from "zod";
import {
  FleetSpend,
  GatewayPolicy,
  PriceBook,
  SpendBudgets,
  SpendDrill,
  SpendFindingEvidence,
  SpendFindings,
  SpendReport,
  SpendWaste,
  UnpricedModels,
} from "@/data/contracts/spend";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import {
  toFleetSpend,
  toGatewayPolicy,
  toPriceBook,
  toSpendBudgets,
  toSpendDrill,
  toSpendFindingEvidence,
  toSpendFindings,
  toSpendReport,
  toSpendWaste,
  toUnpricedModels,
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
  async gatewayPolicy(ctx) {
    const read = await kernelRead(ctx, {
      contract: tachoSessionPolicyRead,
      input: {},
      page: "spend",
    });
    return toView(read, GatewayPolicy, toGatewayPolicy, {
      orgId: ctx.orgId,
      method: "gatewayPolicy",
    });
  },
  async findings(ctx) {
    // The section shows what is still open; a finding someone decided leaves
    // the list and its decision is in the audit record.
    const read = await kernelRead(ctx, {
      contract: findingList,
      input: { status: "open" },
      page: "spend",
    });
    return toView(read, SpendFindings, toSpendFindings, {
      orgId: ctx.orgId,
      method: "findings",
    });
  },
  async findingEvidence(ctx, findingId) {
    const read = await kernelRead(ctx, {
      contract: findingEvidenceGet,
      input: { findingId },
      page: "spend",
    });
    return toView(read, SpendFindingEvidence, toSpendFindingEvidence, {
      orgId: ctx.orgId,
      method: "findingEvidence",
    });
  },
  async priceBook(ctx) {
    // No `at`: the book as it stands now is the one a person is about to
    // change, and the contract resolves the read instant itself.
    const read = await kernelRead(ctx, {
      contract: costPriceEntryList,
      input: { includeScheduled: true },
      page: "spend",
    });
    return toView(read, PriceBook, toPriceBook, {
      orgId: ctx.orgId,
      method: "priceBook",
    });
  },
  async unpricedModels(ctx) {
    // No `since`: the contract's own window (30 days) is the span the tab
    // reports, and it answers the one it used.
    const read = await kernelRead(ctx, {
      contract: costUnpricedModelList,
      input: {},
      page: "spend",
    });
    return toView(read, UnpricedModels, toUnpricedModels, {
      orgId: ctx.orgId,
      method: "unpricedModels",
    });
  },
};
