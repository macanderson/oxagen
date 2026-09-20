/**
 * Mint a new organisation's own OpenRouter key, after its creation has
 * committed (ADR-131).
 *
 * Separate from `org.create` rather than inline in it, for one reason worth
 * stating: this calls a third party over HTTPS, and organisation creation is
 * a single Postgres transaction that must not be held open across a vendor's
 * latency. It also must not be rolled back by one — a rollback after a
 * successful mint would strand a live, spendable key with no row to find it
 * by. So the transaction commits first, and this runs after it, detached.
 *
 * Detached means the signup path never waits for it and never fails on it.
 * An organisation whose key was not minted serves on Oxagen's shared key,
 * which is what every organisation did before ADR-131: the assistant works,
 * the credits are charged the same, and what is lost is the vendor-side
 * per-customer usage figure until a backfill fills it in.
 */
import { eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { ensureAssistantModelKey } from "@oxagen/ai/key-provisioning";
import { logger } from "./logger";

export interface ProvisionAssistantModelKeyArgs {
  readonly orgId: string;
  /** The slug at creation. Baked into the key's name and never rewritten. */
  readonly orgSlug: string;
  /** The person who created the organisation; their email names the key. */
  readonly userId: string;
}

/**
 * Provision the key, reporting the outcome to the log and to nobody else.
 *
 * Returns a promise so a test can await it; production callers attach a
 * `.catch()` and move on. It does not throw: every failure inside
 * `ensureAssistantModelKey` is already answered as "not provisioned", and the
 * only thing that can throw here is the email read, which is caught below.
 */
export async function provisionAssistantModelKey(
  args: ProvisionAssistantModelKeyArgs,
): Promise<void> {
  let creatorEmail: string;
  try {
    // tenancy: system bypass via withSystemDb (bootstrap — reads an auth-schema
    // row for an organisation whose tenant scope does not exist yet) (see
    // docs/specs/tenancy-rls/spec.md)
    const user = await withSystemDb((tx) =>
      tx.query.users.findFirst({
        where: eq(schema.users.id, args.userId),
        columns: { email: true },
      }),
    );
    // An organisation cannot be created without an authenticated user, so a
    // missing row here means something is wrong upstream. It is still not a
    // reason to skip the key: `assistantKeyName` renders a missing field as
    // `unknown`, which reads as missing information rather than as a bug, and
    // the key's real identity is its hash and its row either way.
    creatorEmail = user?.email ?? "";
  } catch (err) {
    logger.error(
      { err, orgId: args.orgId },
      "assistant-model-key: could not read the creator's email — provisioning skipped",
    );
    return;
  }

  const result = await ensureAssistantModelKey({
    orgId: args.orgId,
    orgSlug: args.orgSlug,
    creatorEmail,
    actorUserId: args.userId,
  });

  if (result.provisioned) {
    logger.info(
      { orgId: args.orgId, slug: args.orgSlug },
      "assistant-model-key: provisioned the organisation's own model key",
    );
    return;
  }
  // `disabled` is the shape of an environment with no management key, which is
  // every developer laptop, so it is not worth a warning on every signup.
  logger.info(
    { orgId: args.orgId, slug: args.orgSlug, reason: result.reason },
    "assistant-model-key: not provisioned — the organisation serves on the shared key",
  );
}
