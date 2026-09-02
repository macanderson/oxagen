import { createFunction } from "../create-function";
import { schema, withSystemDb } from "@oxagen/database";
import { storage } from "@oxagen/storage";
import { eq, inArray } from "drizzle-orm";
import { logger } from "../logger";

/**
 * GDPR Article 20 — data portability export pipeline (OXA-1722).
 *
 * Triggered by event `privacy/export.process`. The caller (privacy.data.export
 * handler) inserts a `privacyExportRequests` row with `status = 'queued'` before
 * dispatching this event.
 *
 * Steps:
 *   1. Mark record as `processing`.
 *   2. Assemble a READ-ONLY ZIP of the data subject's (or org's) data, upload it
 *      to Vercel Blob as a PRIVATE object, and mark the request `ready` with the
 *      stored URL. The ZIP contains:
 *        - user-profile.json      — the subject's own `users` row (CORE — a
 *                                    failure here aborts the whole export).
 *        - conversations/<id>.json — one file per conversation with its messages.
 *        - api-keys.json          — key METADATA ONLY (id, name, prefix,
 *                                    created_at, last_used_at, scopes). NEVER the
 *                                    hashed or plaintext key material.
 *        - audit-log.json         — security_events for the subject/org.
 *        - generated-assets.json  — generated-asset METADATA.
 *        - members.json / workspaces.json — org scope only.
 *
 * Scope semantics:
 *   - `user` — the subject's own rows (conversations by userId, api keys created
 *     by the user, audit events actored by the user, assets owned by the user).
 *   - `org`  — every row scoped to the org (all conversations/keys/audit/assets
 *     in the org) plus members.json and workspaces.json. The subject profile is
 *     still included as the request originator.
 *
 * Resilience: each OPTIONAL artifact is read independently; a single failed read
 * is logged and skipped so a partial export still ships (a partial export beats
 * none). Only a failure to read the CORE profile aborts — an export with no
 * profile is meaningless. All reads go through `withSystemDb` (RLS bypass): an
 * org-scoped export legitimately crosses every workspace in the org, and a
 * user-scoped export must resolve the subject's rows before any tenant scope is
 * established here.
 *
 * The blob is written with `access: "private"` — a data-subject export is highly
 * sensitive PII and must never be world-readable; it is served back through the
 * authenticated storage `get()` path, never a public CDN URL.
 */

/** A single ZIP entry: logical path → UTF-8 encoded bytes. */
type ZipEntries = Record<string, Uint8Array>;

const encoder = new TextEncoder();

/** JSON-encode `value` (pretty-printed) into the ZIP entry map under `name`. */
function addJsonEntry(entries: ZipEntries, name: string, value: unknown): void {
  entries[name] = encoder.encode(JSON.stringify(value, null, 2));
}

/**
 * Run one OPTIONAL artifact read. A failure is logged with the artifact name and
 * swallowed so the remaining artifacts still make it into the ZIP. Never used for
 * the CORE profile read, which must abort the export on failure.
 */
async function collectOptional(
  exportId: string,
  artifact: string,
  read: () => Promise<void>,
): Promise<void> {
  try {
    await read();
  } catch (err: unknown) {
    logger.error(
      {
        exportId,
        artifact,
        error: err instanceof Error ? err.message : String(err),
      },
      "privacy.export-process: optional artifact read failed — skipping (partial export)",
    );
  }
}

export const [privacyExportProcess, privacyExportProcessOnFailure] =
  createFunction(
    {
      id: "privacy.export-process",
      retries: 2,
      concurrency: { limit: 5, key: "event.data.userId" },
      onFailure: async ({ event, step }) => {
        const failureData = event.data as {
          event?: { data?: { exportId?: string } };
          error?: unknown;
        };
        const exportId = failureData.event?.data?.exportId;
        if (!exportId) return;

        const errorMessage =
          typeof failureData.error === "object" &&
          failureData.error !== null &&
          "message" in failureData.error
            ? String((failureData.error as { message: unknown }).message)
            : String(failureData.error ?? "unknown error");

        await step.run("mark-failed", async () => {
          await withSystemDb((tx) =>
            tx
              .update(schema.privacyExportRequests)
              .set({ status: "failed", errorMessage, updatedAt: new Date() })
              .where(eq(schema.privacyExportRequests.id, exportId)),
          );
        });

        logger.error(
          { exportId, error: errorMessage },
          "privacy.export-process failed",
        );
      },
    },
    { event: "privacy/export.process" },
    async ({ event, step }) => {
      const { exportId, userId, orgId, scope } = event.data as {
        exportId: string;
        userId: string;
        orgId: string;
        scope: "user" | "org";
      };

      // Step 1: mark processing.
      await step.run("mark-processing", async () => {
        await withSystemDb((tx) =>
          tx
            .update(schema.privacyExportRequests)
            .set({ status: "processing", updatedAt: new Date() })
            .where(eq(schema.privacyExportRequests.id, exportId)),
        );
      });

      // Step 2: assemble the ZIP, upload it privately, and capture the stored URL.
      // Everything (DB reads + zip + upload) happens inside a single durable step
      // so the step's return value stays small and JSON-serializable (the raw ZIP
      // bytes never cross the step boundary) and the upload is memoized — a retry
      // of the subsequent mark-ready step never re-uploads.
      const uploaded = await step.run("assemble-and-upload", async () => {
        const entries = await withSystemDb(async (tx) => {
          const collected: ZipEntries = {};

          // CORE: subject profile. Its absence makes the export meaningless, so a
          // failure here throws and aborts (the function retries, then fails loud).
          const profileRows = await tx
            .select()
            .from(schema.users)
            .where(eq(schema.users.id, userId));
          const profile = profileRows[0];
          if (!profile) {
            throw new Error(
              `user ${userId} not found — cannot assemble export`,
            );
          }
          addJsonEntry(collected, "user-profile.json", profile);

          // conversations/<publicId>.json — one file per conversation with its
          // messages nested. Scope decides subject-only vs org-wide.
          await collectOptional(exportId, "conversations", async () => {
            const conversations = await tx
              .select()
              .from(schema.conversations)
              .where(
                scope === "org"
                  ? eq(schema.conversations.orgId, orgId)
                  : eq(schema.conversations.userId, userId),
              );

            const conversationIds = conversations.map((c) => c.id);
            const messages =
              conversationIds.length > 0
                ? await tx
                    .select()
                    .from(schema.messages)
                    .where(
                      inArray(schema.messages.conversationId, conversationIds),
                    )
                : [];

            const messagesByConversation = new Map<
              string,
              (typeof messages)[number][]
            >();
            for (const message of messages) {
              const bucket =
                messagesByConversation.get(message.conversationId) ?? [];
              bucket.push(message);
              messagesByConversation.set(message.conversationId, bucket);
            }

            for (const conversation of conversations) {
              addJsonEntry(
                collected,
                `conversations/${conversation.publicId}.json`,
                {
                  conversation,
                  messages: messagesByConversation.get(conversation.id) ?? [],
                },
              );
            }
          });

          // api-keys.json — METADATA ONLY. keyHash / any key material is NEVER
          // read into the export. User scope = keys the subject created; org scope
          // = all keys in the org.
          await collectOptional(exportId, "api-keys.json", async () => {
            const apiKeyRows = await tx
              .select({
                id: schema.apiKeys.publicId,
                name: schema.apiKeys.name,
                prefix: schema.apiKeys.keyPrefix,
                createdAt: schema.apiKeys.createdAt,
                lastUsedAt: schema.apiKeys.lastUsedAt,
                scopes: schema.apiKeys.scope,
                expiresAt: schema.apiKeys.expiresAt,
              })
              .from(schema.apiKeys)
              .where(
                scope === "org"
                  ? eq(schema.apiKeys.orgId, orgId)
                  : eq(schema.apiKeys.createdByUserId, userId),
              );
            addJsonEntry(collected, "api-keys.json", apiKeyRows);
          });

          // audit-log.json — security_events actored by the subject (user scope)
          // or for the whole org (org scope).
          await collectOptional(exportId, "audit-log.json", async () => {
            const auditRows = await tx
              .select()
              .from(schema.securityEvents)
              .where(
                scope === "org"
                  ? eq(schema.securityEvents.orgId, orgId)
                  : eq(schema.securityEvents.actorUserId, userId),
              );
            addJsonEntry(collected, "audit-log.json", auditRows);
          });

          // generated-assets.json — asset METADATA. sizeBytes is a bigint; coerce
          // to a JSON-safe number (asset sizes are well below 2^53).
          await collectOptional(exportId, "generated-assets.json", async () => {
            const assetRows = await tx
              .select({
                id: schema.generatedAssets.publicId,
                kind: schema.generatedAssets.kind,
                accessPolicy: schema.generatedAssets.accessPolicy,
                status: schema.generatedAssets.status,
                mimeType: schema.generatedAssets.mimeType,
                sizeBytes: schema.generatedAssets.sizeBytes,
                storageProvider: schema.generatedAssets.storageProvider,
                storageUrl: schema.generatedAssets.storageUrl,
                prompt: schema.generatedAssets.prompt,
                model: schema.generatedAssets.model,
                conversationId: schema.generatedAssets.conversationId,
                createdAt: schema.generatedAssets.createdAt,
              })
              .from(schema.generatedAssets)
              .where(
                scope === "org"
                  ? eq(schema.generatedAssets.orgId, orgId)
                  : eq(schema.generatedAssets.userId, userId),
              );
            addJsonEntry(
              collected,
              "generated-assets.json",
              assetRows.map((row) => ({
                ...row,
                sizeBytes: row.sizeBytes == null ? null : Number(row.sizeBytes),
              })),
            );
          });

          // Org scope only: the org's members and workspaces.
          if (scope === "org") {
            await collectOptional(exportId, "members.json", async () => {
              const memberRows = await tx
                .select({
                  id: schema.orgUsers.publicId,
                  userId: schema.orgUsers.userId,
                  role: schema.orgUsers.role,
                  joinedAt: schema.orgUsers.joinedAt,
                })
                .from(schema.orgUsers)
                .where(eq(schema.orgUsers.orgId, orgId));
              addJsonEntry(collected, "members.json", memberRows);
            });

            await collectOptional(exportId, "workspaces.json", async () => {
              const workspaceRows = await tx
                .select({
                  id: schema.workspaces.publicId,
                  name: schema.workspaces.name,
                  slug: schema.workspaces.slug,
                  createdAt: schema.workspaces.createdAt,
                })
                .from(schema.workspaces)
                .where(eq(schema.workspaces.orgId, orgId));
              addJsonEntry(collected, "workspaces.json", workspaceRows);
            });
          }

          return collected;
        });

        // Build the ZIP in memory. fflate's zipSync is pure-JS and serverless-safe;
        // the artifacts are already buffered so the synchronous path is simplest.
        const { zipSync } = await import("fflate");
        const zipBytes = zipSync(entries, { level: 6 });

        // Upload as a PRIVATE blob — a data-subject export must never be served
        // from a public CDN URL. The key is server-controlled and unpredictable.
        const key = `privacy-exports/${orgId}/${exportId}.zip`;
        const result = await storage().put({
          key,
          body: zipBytes,
          contentType: "application/zip",
          access: "private",
        });

        logger.info(
          {
            exportId,
            userId,
            orgId,
            scope,
            entryCount: Object.keys(entries).length,
            bytes: result.bytes,
          },
          "privacy.export-process: ZIP assembled and uploaded",
        );

        return { url: result.url, bytes: result.bytes };
      });

      // Step 3: mark the request ready with the stored export URL.
      await step.run("mark-ready", async () => {
        await withSystemDb((tx) =>
          tx
            .update(schema.privacyExportRequests)
            .set({
              status: "ready",
              exportUrl: uploaded.url,
              completedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(schema.privacyExportRequests.id, exportId)),
        );
      });

      logger.info(
        { exportId, userId, orgId, scope },
        "privacy.export-process: request marked ready",
      );
    },
  );
