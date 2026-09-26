// What the kernel seam records about a failed invoke (#3841): the rule that
// refused it, the trace it ran under, the region that answered and the
// request id the seam minted. A page prints them on its denied and error
// states, so a person has something to hand support and can see which rule
// said no.
//
// Read by duck typing, like the seam's own classification: a kernel module can
// be evaluated twice in one process (the RSC and SSR graphs), so `instanceof`
// is never used, and no fact is read from message text.
//
// - An IAM refusal carries `decidedBy`, the resolver's rule id, on the
//   kernel's CapabilityError (`authz_denied`, `pending_approval`).
// - A workspace decision rule's refusal carries `verdict.ruleId` on
//   DecisionRuleDeniedError and DecisionRuleApprovalRequiredError
//   (@oxagen/rules).
// - The trace id is the OpenTelemetry trace active when the read failed. With
//   no tracer configured there is none, and it reads null.
import "server-only";
import { currentTraceIds } from "@oxagen/telemetry";
import type { DecidedBy, ReadFailureFacts } from "@/data/read";
import { deployRegion } from "./region";

const IAM_CODES: readonly string[] = ["authz_denied", "pending_approval"];
const DECISION_RULE_CODES: readonly string[] = [
  "decision_rule_denied",
  "decision_rule_approval_required",
];

const stringField = (value: unknown, key: string): string | null => {
  if (typeof value !== "object" || value === null) return null;
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" && field !== "" ? field : null;
};

/** The rule that refused a call, or null when the error names none. */
export function decidedByOf(err: unknown): DecidedBy | null {
  const code = stringField(err, "code");
  if (code === null) return null;
  if (IAM_CODES.includes(code)) {
    const rule = stringField(err, "decidedBy");
    return rule === null ? null : { source: "iam", id: rule };
  }
  if (DECISION_RULE_CODES.includes(code)) {
    const verdict: unknown =
      typeof err === "object" && err !== null
        ? Reflect.get(err, "verdict")
        : undefined;
    const rule = stringField(verdict, "ruleId");
    return rule === null ? null : { source: "decision_rule", id: rule };
  }
  return null;
}

/**
 * The trace id active now, or null. `currentTraceIds` answers an empty id for
 * an invalid span context, which is what a process with no tracer has.
 *
 * This runs while the seam handles a failure, so it must not become a second
 * one: a trace read that throws (a tracer misconfigured, or a test double of
 * @oxagen/telemetry that leaves the function out) reads as not recorded, and
 * the page still renders the refusal it was classifying.
 */
export function activeTraceId(): string | null {
  let id: string;
  try {
    id = currentTraceIds().trace_id;
  } catch {
    return null;
  }
  return id === "" ? null : id;
}

/** The facts of a failed invoke, read at the moment it failed. */
export function failureFacts(requestId: string): ReadFailureFacts {
  return { traceId: activeTraceId(), region: deployRegion(), requestId };
}
