// The Model spend half of the Edit workspace form (#5426): the three daily
// budget inputs, read into the patch `update_workspace_settings` takes. Pure,
// and apart from `actions.ts` because that module is a server module and may
// export async functions only; the dialog reads the form on the client and
// refuses a bad value before any write runs.
import type { WorkspaceSpendSettings } from "@/data/contracts/org";

/** The form field each lane's input carries, by the lane's settings key. */
export const BUDGET_FIELDS = {
  runEnrichment: "budgetRunEnrichment",
  assistant: "budgetAssistant",
  work: "budgetWork",
} as const;

export type BudgetLane = keyof typeof BUDGET_FIELDS;

/** The lanes in the order the form draws them. `satisfies` keeps it to known lanes. */
export const BUDGET_LANES = [
  "runEnrichment",
  "assistant",
  "work",
] as const satisfies readonly BudgetLane[];

/**
 * The patch `update_workspace_settings` takes for `dailyBudgetUsd`: a number
 * sets a lane's limit, null removes it, and a lane left out is unchanged. The
 * same shape as the contract's `dailyBudgetUsdPatchSchema`, spelled here so
 * the browser bundle loads no schema; the typed write holds the two together.
 */
export type DailyBudgetUsdPatch = Partial<Record<BudgetLane, number | null>>;

/**
 * A refusal the dialog shows as an invalid input, in the shape every
 * Organization write answers (`ActionResult`), named on the input at fault.
 */
export type BudgetRefused = {
  ok: false;
  reason: "invalid";
  code: "invalid_input";
  field: (typeof BUDGET_FIELDS)[BudgetLane];
};

/**
 * The patch the three inputs make.
 *
 * A blank input means different things by what was stored. When the stored
 * value was a number, blank is the person clearing it, so the lane is sent
 * as null and the limit goes. When the stored value was null, or the settings
 * could not be read at all, blank is the input as it opened, so the lane is
 * left out and the write leaves it alone. A number is sent as typed, 0
 * included: 0 is the lane switched off, and the contract's own parse refuses
 * anything over its ceiling. A negative or a value that is not a number is
 * refused here, before any write, on the field it came from.
 */
export function budgetPatchOf(
  form: FormData,
  stored: WorkspaceSpendSettings["dailyBudgetUsd"] | null,
): { ok: true; patch: DailyBudgetUsdPatch } | BudgetRefused {
  const patch: DailyBudgetUsdPatch = {};
  for (const lane of BUDGET_LANES) {
    const field = BUDGET_FIELDS[lane];
    const raw = form.get(field);
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text === "") {
      if (stored !== null && stored[lane] !== null) patch[lane] = null;
      continue;
    }
    const value = Number(text);
    if (!Number.isFinite(value) || value < 0) {
      return { ok: false, reason: "invalid", code: "invalid_input", field };
    }
    patch[lane] = value;
  }
  return { ok: true, patch };
}
