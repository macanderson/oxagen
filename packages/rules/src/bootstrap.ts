/**
 * bootstrap.ts — wire the decision-rules gate into the AI kernel.
 *
 * The kernel refuses to import `@oxagen/rules` directly (same vendor-neutral,
 * no-cycle rule as billing), so it exposes an injection slot. Every service
 * surface that runs agent actions — api, app, mcp, the durable-run worker —
 * calls `bootstrapDecisionRulesRuntime()` once at startup, the same pattern as
 * `bootstrapBillingRuntime()`. Without the call the gate is dormant and every
 * capability proceeds exactly as before rules existed.
 *
 * Where the rules live, and the cache in front of them, are in `rule-store.ts`.
 */
import { setDecisionRulesGate } from "@oxagen/oxagen/kernel";
import { autoApproveParkedCall } from "./auto-approval-path";
import { createDecisionRulesGate } from "./gate";
import { checkMandate } from "./mandates";
import { loadWorkspaceRuleSet, loadCurrentRuleSet } from "./rule-store";
import { logger } from "./logger";

let booted = false;

export function bootstrapDecisionRulesRuntime(): void {
  if (booted) return;
  booted = true;
  setDecisionRulesGate(
    createDecisionRulesGate({
      loadRuleSet: (args) =>
        args.externalTool || args.requireFreshRules
          ? loadCurrentRuleSet(args)
          : loadWorkspaceRuleSet(args),
      // The mandate check for agent principals (ADR-059 decision 4).
      checkMandate,
      // The auto-approval clause of the same rule set (ADR-070): a call a rule
      // sent to a person skips them when an auto-approval rule's conditions
      // hold, recorded as an approval whose approver is `policy:<rule id>`.
      autoApprove: autoApproveParkedCall,
      // No fact resolver yet: rules over `facts.…` keys parse and load, and
      // their leaves read an absent bag until the aggregate resolver lands
      // with the registry work. Rules over `input.…` and `call.…` bind fully.
      onError: (error) => {
        logger.warn(
          { err: error },
          "decision rules: gate infrastructure failure — failing open",
        );
      },
    }),
  );
  logger.info({}, "rules: decision gate wired into kernel.invoke()");
}

export {
  clearDecisionRulesCache,
  loadWorkspaceRuleSet,
} from "./rule-store";
