import type { CapabilityHandler } from "@oxagen/oxagen";
import { runOutcomesSettingsGet } from "@oxagen/oxagen/contracts/run.outcomes.settings.get";
import { readRunOutcomesPolicy } from "@oxagen/plugins/run-outcomes-policy";

export const runOutcomesSettingsGetHandler: CapabilityHandler<
  typeof runOutcomesSettingsGet
> = async (_input, ctx) =>
  readRunOutcomesPolicy({ orgId: ctx.orgId, workspaceId: ctx.workspaceId });
