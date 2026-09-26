// The operator's workspace role as a run records it (#3999, ADR-197).
//
// A run is stamped with the role its operator held in the run's workspace when
// the run opened: `tacho.sessions.operator_role` by ingest's genesis row, and
// `agent.agent_runs.operator_role` by the ledger's create statement. Both
// columns hold the lowercased value, and the read hands it back unchanged, so
// a role changed later never rewrites the record.
import { RUN_OPERATOR_ROLES } from "@oxagen/oxagen/contracts/run.list";

/** A workspace role in the words a run records it. */
export type RunOperatorRole = (typeof RUN_OPERATOR_ROLES)[number];

function isOperatorRole(value: string): value is RunOperatorRole {
  return (RUN_OPERATOR_ROLES as readonly string[]).includes(value);
}

/**
 * A role in the words a run records it, or null. `workspace_users.role` is
 * written in both casings (the workspace create path writes `owner`, IAM
 * writes `Owner`), so it is lowercased first. A value outside the six roles
 * reads as none rather than as a guess, which is also how a stored value that
 * a later CHECK would refuse reaches a caller.
 */
export function operatorRoleOf(
  role: string | null | undefined,
): RunOperatorRole | null {
  if (!role) return null;
  const lowered = role.toLowerCase();
  return isOperatorRole(lowered) ? lowered : null;
}
