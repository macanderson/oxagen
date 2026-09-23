// audit-exempt: read-only — lists the organization's cost-center labels from cost.cost_centers; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// `list_cost_centers` (ADR-142): the organization's live labels with how many
// agents and workspaces name each.
import type { CapabilityHandler } from "@oxagen/oxagen";
import type { costCenterList } from "@oxagen/oxagen/contracts/cost_center.list";
import { readCostCenters } from "./cost_center.shared";

export const costCenterListHandler: CapabilityHandler<
  typeof costCenterList
> = async (_input, ctx) => ({
  costCenters: await readCostCenters(ctx.orgId),
});
