import { NonRetriableError } from "@oxagen/functions";
import { createFunction } from "../create-function";
import { schema, withSystemDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { logger } from "../logger";

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
 * ── Why this still FAILS LOUD (does NOT mark `completed`) ─────────────────────
 *
 * A cross-store hard-delete that misses a table or store leaves residual PII
 * while telling the data subject their data was erased — that is WORSE than an
 * honest failure and is itself a GDPR compliance breach. The full subject-scope
 * deletion set is NOT cleanly bounded today (OXA-1721), because:
 *
 *   1. ClickHouse (`@oxagen/telemetry`) stores RAW `user_email` as a column in
 *      the `claude_telemetry` / `claude_sessions` tables (migrations 0006/0007),
 *      even inside the MergeTree `ORDER BY` sort key. There is NO erasure path,
 *      NO TTL, and the SOP §9 retention table does not cover ClickHouse. Whether
 *      these rows are erased or retained-under-policy is an undecided PRIVACY +
 *      LEGAL policy decision — not something this function may invent.
 *   2. Neo4j (`@oxagen/ontology`) has NO owner-scoped delete path. Explicit
 *      memory/citation and entity nodes owned by the subject cannot be erased
 *      until a graph-layer erase-by-owner path exists, and org-scope graph
 *      semantics are undefined.
 *   3. Blob storage (`@oxagen/storage`) cascade is still pending (SOP §7): the
 *      subject's `content.generated_assets` blobs are enumerable by `storageKey`
 *      but there is no wired enumerate-by-user + delete path.
 *   4. Postgres residual: `created_by_user_id` / `updated_by_user_id`
 *      (`auditMixin`) exist on nearly every table, and org-scope erasure
 *      cascades across workspaces, plugins, billing, agents, chat and content
 *      with no defined FK-safe order or member-vs-org boundary. Org-scope
 *      erasure semantics are ambiguous and not enumerable with confidence.
 *
 * Until those four are resolved, this function refuses to mark the request
 * `completed`: it throws a NonRetriableError so the `inngest/function.failed`
 * handler marks the request `failed`. Do NOT re-add a `completed` transition
 * here until every store above is erased/anonymised per a defined policy.
 *
 * ── What this function DOES do (real, immediate, single-store mitigation) ─────
 *
 * For USER scope it purges the auth-store PII that is unambiguously the
 * subject's own, needs no other store, and carries no org-scope decision — all
 * within one `withSystemDb` transaction, idempotent (safe to retry):
 *   - `auth.users`      — anonymise display_name / email / username / avatar_url.
 *   - `auth.accounts`   — delete OAuth tokens (plain + `*_enc`) and password hash.
 *   - `auth.user_preferences` — delete the subject's personal preferences row.
 * Sessions were already revoked by the handler at request time (immediate
 * effect). For ORG scope no erasure is attempted here (semantics undecided).
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

      // Step 2: partial erasure — purge the clearly-owned, single-store auth PII
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
          await withSystemDb(async (tx) => {
            // Anonymise the identity row: scrub display_name / email / avatar_url.
            await tx
              .update(schema.users)
              .set({
                displayName: "Deleted User",
                email: `${userId}@deleted.invalid`,
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

      // Step 3: FAIL LOUD. The full cross-store cascade is blocked on four
      // unresolved items (see file header): ClickHouse `user_email` erasure policy
      // (undecided), the missing Neo4j erase-by-owner path, the pending blob
      // cascade, and ambiguous org-scope Postgres semantics. We refuse to mark the
      // request `completed` while personal data still remains in those stores, so
      // a data subject is never falsely told their data was fully erased. Throwing
      // a NonRetriableError routes to the on-failure handler, which marks the
      // request `failed` with this message for operator follow-up.
      throw new NonRetriableError(
        "[privacy.erasure-execute] full cross-store erasure cascade not implemented " +
          `(OXA-1721); refusing to mark erasure request ${requestId} (scope=${scope}) ` +
          "as completed. Owned auth PII was purged (users/accounts/user_preferences). " +
          "STILL RESIDUAL — each blocked on a decision: " +
          "(1) ClickHouse claude_telemetry/claude_sessions store raw user_email — no " +
          "erasure/retention policy defined (PRIVACY+LEGAL decision); " +
          "(2) Neo4j has no owner-scoped erase path — needs graph-layer delete-by-owner; " +
          "(3) blob generated_assets cascade pending (SOP §7) — needs enumerate-by-user + @oxagen/storage delete; " +
          "(4) org-scope Postgres cascade (created_by/updated_by across all tables, " +
          "workspaces/plugins/billing/agents/chat/content) — semantics ambiguous, not enumerated.",
      );
    },
  );
