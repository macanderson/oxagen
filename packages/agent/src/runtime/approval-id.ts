import { schema } from "@oxagen/database";
import { eq, type SQL } from "drizzle-orm";
import { isApprovalPublicId } from "@oxagen/oxagen/contracts/agent.approval.resolve";

/**
 * The WHERE term that finds an approval request by either of its ids (#2906).
 *
 * The app and the list reads show the public id (`apr_…`); the
 * runtime and the deprecated app carry the row uuid. A value shaped like a
 * public id matches `public_id`; anything else matches `id`. The contract has
 * already refused values that are neither, so a uuid literal never reaches
 * Postgres malformed.
 *
 * Callers must still add the org and workspace filters: this term identifies
 * the row, it does not scope it.
 */
export function approvalIdCondition(approvalId: string): SQL {
  return isApprovalPublicId(approvalId)
    ? eq(schema.approvalRequests.publicId, approvalId)
    : eq(schema.approvalRequests.id, approvalId);
}
