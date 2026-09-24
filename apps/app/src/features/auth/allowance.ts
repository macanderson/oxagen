// The Free plan's included allowance for the sign-up tags (signup.md, Data
// sources: "Included allowance (the tag)", backed by billing.plans). A new
// organization starts on the Free plan, so its row is the allowance a visitor
// gets. The tag is drawn only when that plan includes governed actions; a
// missing row, a zero allowance or a failed read draws nothing (INV-18).
import "server-only";
import { captureError } from "@oxagen/telemetry";
import { readFreePlanAllowance } from "@/server/viewer";

/** Whether the plan a new organization starts on includes a monthly allowance. */
export async function signupIncludesAllowance(): Promise<boolean> {
  try {
    const included = await readFreePlanAllowance();
    return included !== null && included > 0;
  } catch (error) {
    captureError({
      error,
      source: "app",
      context: "signup.allowance read_failed",
    });
    return false;
  }
}
