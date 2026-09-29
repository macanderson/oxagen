// cedar-schema.ts: the Cedar vocabulary the autonomy policies are written in.
//
// The principal is the scope's operator, because Oxagen acts as that person.
// The resource is one work order as it stands at the moment Oxagen would act.
// Its level is data, not policy text: a lowering written a minute ago changes
// the attribute on the next call, and the policies stay as work.toml wrote them.
import type { AutonomyLevel, WorkAction } from "../types";

/** The Cedar entity type of the principal: the scope's operator. */
export const AUTONOMY_PRINCIPAL_TYPE = "Oxagen::Operator" as const;

/** The Cedar entity type of every autonomy action. */
export const AUTONOMY_ACTION_TYPE = "Oxagen::Action" as const;

/** The Cedar entity type of the resource. */
export const AUTONOMY_RESOURCE_TYPE = "Oxagen::WorkOrder" as const;

/** The lowest level at which each action is allowed (agent-work-spec.html, Autonomy levels). */
export const AUTONOMY_MIN_LEVEL: Readonly<Record<WorkAction, AutonomyLevel>> = {
  "work.send": 1,
  "work.merge": 2,
  "work.lock": 3,
  "work.close": 3,
};

/**
 * The schema the autonomy policies validate against in strict mode. It sits in
 * the `Oxagen` namespace, so it joins the tool-call schema from
 * `writeCedarSchema` (which declares its types in the empty namespace) without
 * a name clash.
 *
 * `risk` is optional because a work order has no risk until its pull request
 * exists. A policy reads it only after `resource has risk`.
 */
export const AUTONOMY_CEDAR_SCHEMA = `// The autonomy vocabulary: Oxagen acting as a scope's operator on one work order.
namespace Oxagen {
  entity Operator;

  entity WorkOrder {
    scope: String,
    level: Long,
    verdict: String,
    risk?: String,
    lint_passed: Bool,
    close_switch: Bool,
    spent_today_cents: Long
  };

  action "work.send", "work.merge", "work.lock", "work.close"
    appliesTo {
      principal: [Operator],
      resource: [WorkOrder]
    };
}
`;
