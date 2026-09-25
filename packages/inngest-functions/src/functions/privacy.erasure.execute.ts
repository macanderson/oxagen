import { NonRetriableError } from "@oxagen/functions";
import { createFunction } from "../create-function";
import { schema, withSystemDb } from "@oxagen/database";
import { eraseClaudeSessionRows } from "@oxagen/telemetry";
import { eq } from "drizzle-orm";
import { logger } from "../logger";

/** The address `execute-erasure` writes over the subject's own. */
function anonymisedEmail(userId: string): string {
  return `${userId}@deleted.invalid`;
}

/**
 * What `erase-clickhouse-rows` did: deleted the rows, found no address to
 * match them by, or failed after Inngest's retries.
 */
type ClickhouseErase = "erased" | "no_address" | "failed";

/** The summary sentence and the residual items the failure message names. */
function clickhouseReport(outcome: ClickhouseErase): {
  done: string;
  residual: string[];
} {
  const unmatched =
    "ClickHouse claude_sessions rows under a Claude Code address other than the account address, " +
    "and rows in the operator endpoint's internal.claude_sessions, are not matched (ADR-183)";
  switch (outcome) {
    case "erased":
      return {
        done: "The subject's ClickHouse claude_sessions rows under the account address were deleted (ADR-183). ",
        residual: [unmatched],
      };
    case "no_address":
      return {
        done: "",
        residual: [
          "ClickHouse claude_sessions was not erased: no account address was left to match, " +
            "because an earlier run overwrote it, so rows may remain until the two-year TTL",
          unmatched,
        ],
      };
    case "failed":
      return {
        done: "",
        residual: [
          "ClickHouse claude_sessions was not erased: the erase failed after retries, " +
            "so the account address was kept; re-run the request once ClickHouse answers",
          unmatched,
        ],
      };
  }
}

/**
 * GDPR Article 17 — right to erasure execution pipeline.
 *
 * Triggered by `privacy/erasure.execute` after the grace period elapses (or
 * immediately when `PRIVACY_ERASURE_GRACE_DAYS=0`). The handler inserted the
 * `privacyErasureRequests` row with `status = 'queued'` and `scheduledAt` set
 * to now + grace period. Inngest retries the event delivery so the function
 * will only execute once `scheduledAt` has passed (caller sets
 * `sendAt: scheduledAt` on the Inngest event).
 *
 * ── Why this still fails loud (does not mark `completed`) ──────────────────
 *
 * A cross-store hard-delete that misses a table or store leaves residual PII
 * while telling the data subject their data was erased. That is worse than a
 * visible failure, and it is a GDPR compliance breach in its own right. The
 * full subject-scope deletion set is not bounded today (OXA-1721), because:
 *
 *   1. Neo4j (`@oxagen/ontology`) has no owner-scoped delete path. Explicit
 *      memory, citation, and entity nodes the subject owns cannot be erased
 *      until a graph-layer erase-by-owner path exists, and org-scope graph
 *      semantics are undefined.
 *   2. The blob storage cascade (`@oxagen/storage`) is still pending (SOP §7).
 *      The subject's `content.generated_assets` blobs are enumerable by
 *      `storageKey`, but no enumerate-by-user and delete path is wired.
 *   3. Postgres residual: `created_by_id` and `updated_by_id` (`auditMixin`)
 *      exist on nearly every table, and org-scope erasure cascades across
 *      workspaces, plugins, billing, agents, chat, and content with no defined
 *      FK-safe order or member-versus-org boundary. Org-scope erasure
 *      semantics are ambiguous and cannot be enumerated with confidence.
 *
 * Until those three are resolved, this function refuses to mark the request
 * `completed`. It throws a NonRetriableError so the `inngest/function.failed`
 * handler marks the request `failed`. Do not add a `completed` transition
 * here until every store above is erased or anonymised under a defined policy.
 *
 * ClickHouse was a fourth item, and ADR-183 answered most of it.
 * `claude_sessions` (migration 0007) keeps `user_email` under its two-year
 * TTL, and the `erase-clickhouse-rows` step below deletes the rows that hold
 * the subject's account address. Rows under a different Claude Code address,
 * and rows in the operator endpoint's `internal.claude_sessions`, are not
 * matched, so the failure message names them. `tacho_events` holds no address
 * since migration 0031 (#3072).
 *
 * ── What this function does ────────────────────────────────────────────────
 *
 * For user scope, two steps run in this order. Both are idempotent and safe
 * to retry.
 *
 *   - `erase-clickhouse-rows` reads the subject's email address from
 *     `auth.users` and deletes every `claude_sessions` row that holds it. It
 *     runs before `execute-erasure` because that step overwrites the address.
 *     The address stays inside the step: Inngest stores a step's return value
 *     in its run state, so the step returns only whether it erased anything.
 *     A ClickHouse failure that outlasts Inngest's retries does not stop the
 *     auth purge. It keeps the address instead, so a re-run of the request
 *     can still match the rows.
 *   - `execute-erasure` purges the auth-store PII that is plainly the
 *     subject's own, in one `withSystemDb` transaction:
 *       - `auth.users`: anonymise display_name, email, and avatar_url. The
 *         email stays when the ClickHouse erase failed, for the re-run.
 *       - `auth.accounts`: delete OAuth tokens (plain and `*_enc`) and the
 *         password hash.
 *       - `auth.user_preferences`: delete the subject's preferences row.
 *
 * The handler revoked sessions at request time. For org scope no erasure is
 * attempted here, because its semantics are undecided.
 */
export const [privacyErasureExecute, privacyErasureExecuteOnFailure] =
  createFunction(
    {
      id: "privacy.erasure-execute",
      retries: 3,
      concurrency: { limit: 2, key: "event.data.requestId" },
      onFailure: async ({ event, step }) => {
        const failureData = event.data as {
          event?: { data?: { requestId?: string } };
          error?: unknown;
        };
        const requestId = failureData.event?.data?.requestId;
        if (!requestId) return;

        const errorMessage =
          typeof failureData.error === "object" &&
          failureData.error !== null &&
          "message" in failureData.error
            ? String((failureData.error as { message: unknown }).message)
            : String(failureData.error ?? "unknown error");

        await step.run("mark-failed", async () => {
          await withSystemDb((tx) =>
            tx
              .update(schema.privacyErasureRequests)
              .set({ status: "failed", errorMessage, updatedAt: new Date() })
              .where(eq(schema.privacyErasureRequests.id, requestId)),
          );
        });

        logger.error(
          { requestId, error: errorMessage },
          "privacy.erasure-execute failed",
        );
      },
    },
    { event: "privacy/erasure.execute" },
    async ({ event, step }) => {
      const { requestId, userId, orgId, scope, scheduledAt } = event.data as {
        requestId: string;
        userId: string;
        orgId: string;
        scope: "user" | "org";
        scheduledAt: string;
      };

      // Enforce grace period: if we've been triggered before scheduledAt (clock
      // skew, early retry), sleep until the scheduled time.
      const scheduledMs = new Date(scheduledAt).getTime();
      const nowMs = Date.now();
      if (scheduledMs > nowMs) {
        await step.sleep("grace-period-wait", scheduledAt);
      }

      // Step 1: mark processing
      await step.run("mark-processing", async () => {
        await withSystemDb((tx) =>
          tx
            .update(schema.privacyErasureRequests)
            .set({ status: "processing", updatedAt: new Date() })
            .where(eq(schema.privacyErasureRequests.id, requestId)),
        );
      });

      // Step 2: erase the subject's rows from ClickHouse `claude_sessions`
      // (ADR-183). This reads the address `execute-erasure` overwrites, so it
      // runs first. A run that finds only the anonymised address, because an
      // earlier run already overwrote it, logs that it had nothing to match.
      // Inngest retries a failing step. Once it gives up, the failure is
      // thrown here, and the auth purge below still runs with the address
      // kept, so a re-run can erase the rows.
      let clickhouseErase: ClickhouseErase | null = null;
      if (scope === "user") {
        try {
          const { erased } = await step.run(
            "erase-clickhouse-rows",
            async () => {
              // tenancy: reads one auth.users row filtered by the event userId, the erasure subject; auth is global with no org_id.
              const [subject] = await withSystemDb((tx) =>
                tx
                  .select({ email: schema.users.email })
                  .from(schema.users)
                  .where(eq(schema.users.id, userId))
                  .limit(1),
              );
              const email = subject?.email ?? "";
              if (email === "" || email === anonymisedEmail(userId)) {
                logger.warn(
                  { requestId, userId },
                  "privacy.erasure-execute: no address left to match in claude_sessions",
                );
                return { erased: false };
              }
              await eraseClaudeSessionRows(email);
              return { erased: true };
            },
          );
          clickhouseErase = erased ? "erased" : "no_address";
        } catch (err) {
          logger.error(
            { requestId, userId, err },
            "privacy.erasure-execute: claude_sessions erase failed, keeping the address for a re-run",
          );
          clickhouseErase = "failed";
        }
      }
      const keepAddress = clickhouseErase === "failed";

      // Step 3: partial erasure. Purge the clearly-owned, single-store auth PII
      // for USER scope. This is a real, immediate mitigation, NOT the full
      // cascade. All statements are scoped by userId, idempotent, and run in one
      // transaction so a mid-step crash leaves the auth store consistent. See the
      // file header for why the full cross-store cascade is not attempted here.
      await step.run("execute-erasure", async () => {
        logger.info(
          { requestId, userId, orgId, scope },
          "privacy.erasure-execute: purging owned auth PII (partial — full cross-store cascade blocked, OXA-1721)",
        );

        if (scope === "user") {
          // tenancy: every statement is filtered by the event userId; the auth tables are global with no org_id.
          await withSystemDb(async (tx) => {
            // Anonymise the identity row: scrub display_name / email / avatar_url.
            await tx
              .update(schema.users)
              .set({
                displayName: "Deleted User",
                // A failed claude_sessions erase keeps the address. It is the
                // only key a re-run can match those rows by (ADR-183).
                ...(keepAddress ? {} : { email: anonymisedEmail(userId) }),
                avatarUrl: null,
                updatedAt: new Date(),
              })
              .where(eq(schema.users.id, userId));

            // Purge OAuth tokens (plaintext + envelope-encrypted) and the password
            // hash — unambiguously the subject's credentials.
            await tx
              .delete(schema.accounts)
              .where(eq(schema.accounts.userId, userId));

            // Remove the subject's personal preferences (theme/language/timezone
            // and notification settings are personal data tied to the person).
            await tx
              .delete(schema.userPreferences)
              .where(eq(schema.userPreferences.userId, userId));
          });
        }
      });

      // Step 4: fail loud. The full cross-store cascade is blocked on three
      // unresolved items (see the file header): the missing Neo4j
      // erase-by-owner path, the pending blob cascade, and ambiguous org-scope
      // Postgres semantics. The request is never marked `completed` while
      // personal data remains in those stores, so a data subject is never told
      // their data was fully erased when it was not. A NonRetriableError routes
      // to the on-failure handler, which marks the request `failed` with this
      // message for operator follow-up.
      const clickhouse =
        clickhouseErase === null ? null : clickhouseReport(clickhouseErase);
      const residual = [
        "Neo4j has no owner-scoped erase path, which needs a graph-layer delete-by-owner",
        "the blob generated_assets cascade is pending (SOP §7), which needs enumerate-by-user and an @oxagen/storage delete",
        "the org-scope Postgres cascade (created_by/updated_by across all tables, " +
          "workspaces/plugins/billing/agents/chat/content) has ambiguous semantics and is not enumerated",
        ...(clickhouse?.residual ?? []),
      ];
      throw new NonRetriableError(
        "[privacy.erasure-execute] full cross-store erasure cascade not implemented " +
          `(OXA-1721); refusing to mark erasure request ${requestId} (scope=${scope}) ` +
          "as completed. " +
          (scope === "user"
            ? keepAddress
              ? "Owned auth PII was purged (users/accounts/user_preferences) except the account address. "
              : "Owned auth PII was purged (users/accounts/user_preferences). "
            : "Org scope erases nothing yet. ") +
          (clickhouse?.done ?? "") +
          "STILL RESIDUAL: " +
          residual.map((item, index) => `(${index + 1}) ${item}`).join("; ") +
          ".",
      );
    },
  );
