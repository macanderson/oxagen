// The user a membership write acts on.
//
// `list_members` prints a member's public id (`auth.users.public_id`, `usr_…`)
// and never their uuid, because a view model in the console carries public ids
// only (apps/app/ARCHITECTURE.md INV-11). `org.org_users.user_id` is a uuid
// column, so a public id handed to `eq(orgUsers.userId, …)` is not a miss — it
// is an `invalid input syntax for type uuid` from Postgres, which reaches the
// caller as an unclassified failure. The membership handlers resolve the public
// id here first, inside the transaction they already hold and bounded by the
// org, and answer `not_found` for one that names nobody in it — the same
// refusal their own IDOR guard makes. A uuid is returned unchanged, so the API
// and MCP callers that pass one are unaffected.
import { schema, type Tx } from "@oxagen/database";
import { HandlerError } from "@oxagen/oxagen";
import { and, eq } from "drizzle-orm";

/** `idMixin("usr")`: the prefix and the Crockford alphabet of a user's public id. */
const USER_PUBLIC_ID = /^usr_[0-9A-Za-z]+$/;

export async function resolveMemberUserId(
  tx: Tx,
  orgId: string,
  target: string,
): Promise<string> {
  if (!USER_PUBLIC_ID.test(target)) return target;
  const [row] = await tx
    .select({ userId: schema.users.id })
    .from(schema.users)
    .innerJoin(schema.orgUsers, eq(schema.orgUsers.userId, schema.users.id))
    .where(
      and(eq(schema.users.publicId, target), eq(schema.orgUsers.orgId, orgId)),
    )
    .limit(1);
  if (!row) {
    throw new HandlerError({
      code: "not_found",
      reason: "target_not_member",
      message: "Target user is not a member of this org",
    });
  }
  return row.userId;
}
