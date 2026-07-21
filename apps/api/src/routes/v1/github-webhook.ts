/**
 * GitHub App webhook receiver.
 *
 * A GitHub App has a single, global webhook URL — every event for every
 * installation is delivered here. That is why this route is App-level
 * (`POST /webhooks/github/app`) and resolves the target connection(s) from the
 * payload's `installation.id` + `repository.full_name`, rather than from a
 * per-connection path segment like the generic `/webhooks/:connector/:conn` route.
 *
 * Security boundary: HMAC-SHA256 over the raw body, verified against the App's
 * single webhook secret (`GITHUB_APP_WEBHOOK_SECRET`) using the
 * `x-hub-signature-256` header. There is no HTTP auth on this route.
 *
 * Flow:
 *   1. Verify the signature against GITHUB_APP_WEBHOOK_SECRET.
 *   2. `ping` → ack. `installation` / `installation_repositories` → reconcile
 *      (pause connections on uninstall/suspend), ack.
 *   3. Resolve connected GitHub connection(s) for this installation + repo.
 *   4. Ask the connector to extract ingestable (sourceRecordType, record) pairs.
 *   5. Fan out one `ingestion/entity.received` per (connection × record). The
 *      6-step pipeline then maps/dedups/embeds exactly as the initial sync does.
 *   6. Additionally, for a `push`, fan out one
 *      `ingestion/repository.ref-updated` per connection carrying the signed
 *      delivery id (docs/specs/workspace-graph-boundary/spec.md §"Push to the
 *      canonical ref"). This route only TRIGGERS the projection — it never
 *      decides canonicality or fetches trees; repository-ref-updated re-reads
 *      the authoritative head from GitHub. The two fan-outs are independent:
 *      a push whose connector extraction is empty still emits ref-updated.
 */

import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { schema, withSystemDb } from "@oxagen/database";
import { and, eq, isNull, sql } from "drizzle-orm";
import { upsertGithubInstallation } from "./github-installations";
import { eventClient } from "../../event-client";
import { getConnector } from "@oxagen/ingestion/connectors";
import { requireEnv } from "@oxagen/config/env";
import { logger } from "../../middleware/logger";
import type { AppEnv } from "../../app";

export const githubAppWebhookRoute = new Hono<AppEnv>();

type EntityReceivedEvent = {
  name: "ingestion/entity.received";
  data: {
    connectionId: string;
    workspaceId: string;
    orgId: string;
    connectorType: string;
    sourceRecordType: string;
    idempotencyKey: string;
    payload: unknown;
    receivedAt: string;
  };
};

type RefUpdatedEvent = {
  name: "ingestion/repository.ref-updated";
  data: {
    orgId: string;
    workspaceId: string;
    connectionId: string;
    installationId: string;
    providerRepoId: string;
    owner: string;
    repo: string;
    ref: string;
    beforeSha: string | null;
    afterSha: string | null;
    forced: boolean;
    deleted: boolean;
    deliveryId: string;
    observedAt: string;
  };
};

/** GitHub's "no commit" sentinel for a branch create (before) or delete (after). */
const ZERO_SHA = "0".repeat(40);

/** Normalize a push SHA: the all-zeros sentinel and "" both mean "no commit". */
function pushSha(value: unknown): string | null {
  if (typeof value !== "string" || value === "" || value === ZERO_SHA)
    return null;
  return value;
}

function verifySignature(
  payload: Uint8Array,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected =
    "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
  const got = Buffer.from(signatureHeader, "utf8");
  const exp = Buffer.from(expected, "utf8");
  // Equal length is required before timingSafeEqual (which throws on a length
  // mismatch) — and is itself part of a correct constant-time comparison.
  if (got.length !== exp.length) return false;
  return timingSafeEqual(got, exp);
}

/** Stable per-record key for idempotency: prefer sha, then numeric id/number. */
function recordKey(record: unknown): string {
  const r = (record ?? {}) as Record<string, unknown>;
  if (typeof r["sha"] === "string") return r["sha"];
  if (typeof r["id"] === "number" || typeof r["id"] === "string")
    return String(r["id"]);
  if (typeof r["number"] === "number") return String(r["number"]);
  return "record";
}

/** Pause every live GitHub connection backed by an installation (uninstall/suspend). */
async function pauseGithubConnections(installationId: string): Promise<void> {
  await withSystemDb((tx) =>
    tx
      .update(schema.sourceConnections)
      .set({ status: "paused", updatedAt: new Date() })
      .where(
        and(
          eq(schema.sourceConnections.connectorId, "github"),
          sql`${schema.sourceConnections.deliveryConfig} ->> 'installationId' = ${installationId}`,
          isNull(schema.sourceConnections.deletedAt),
        ),
      ),
  );
}

githubAppWebhookRoute.post("/", async (c) => {
  const { GITHUB_APP_WEBHOOK_SECRET: secret } = requireEnv([
    "GITHUB_APP_WEBHOOK_SECRET",
  ] as const);
  if (!secret) {
    // Missing webhook secret is a SERVER misconfiguration, not something the
    // request can fix. GitHub records every non-2xx (4xx AND 5xx, including
    // 500/503) as a failed delivery and re-queues it — so any error status here
    // produces an infinite retry flood. We therefore ACK with 200 (drop the
    // event) so GitHub stops retrying, and log loudly so operators see the
    // misconfiguration. This mirrors the ack-and-drop pattern used below for the
    // no-installation-context branch. The real fix is to set
    // GITHUB_APP_WEBHOOK_SECRET in Vercel (oxagen-v2-api, production + preview).
    logger.error(
      { reason: "github_app_webhook_secret_missing" },
      "GitHub App webhook received but GITHUB_APP_WEBHOOK_SECRET is not configured — " +
        "acking with 200 to stop GitHub retries; set GITHUB_APP_WEBHOOK_SECRET in Vercel to process events",
    );
    return c.json(
      {
        received: true,
        dispatched: 0,
        reason: "webhook secret not configured",
      },
      200,
    );
  }

  // Read raw body BEFORE any parsing — HMAC is computed over the exact bytes.
  const rawBody = await c.req.arrayBuffer();
  const payload = new Uint8Array(rawBody);

  if (!verifySignature(payload, c.req.header("x-hub-signature-256"), secret)) {
    return c.json({ error: "Webhook signature invalid" }, 401);
  }

  const eventName = c.req.header("x-github-event") ?? "";

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(Buffer.from(payload).toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return c.json({ error: "Invalid JSON payload" }, 400);
  }

  // Webhook creation handshake — GitHub sends this once when the hook is added.
  if (eventName === "ping") {
    return c.json({ received: true, pong: true }, 200);
  }

  const installation = body["installation"] as
    | { id?: number | string }
    | null
    | undefined;
  const installationId =
    installation && installation.id != null ? String(installation.id) : null;

  // ── Installation lifecycle ────────────────────────────────────────────────
  // GitHub delivers these to the App webhook automatically (no subscription).
  if (
    eventName === "installation" ||
    eventName === "installation_repositories"
  ) {
    const action = typeof body["action"] === "string" ? body["action"] : "";
    const now = new Date();

    if (installationId) {
      // The installation payload (present on both event types) carries the
      // account + app details we keep in the registry.
      const inst = (body["installation"] ?? {}) as {
        account?: {
          login?: string;
          id?: number | string;
          type?: string;
        } | null;
        app_slug?: string;
        repository_selection?: string;
      };
      const meta = {
        accountLogin: inst.account?.login ?? null,
        accountId: inst.account?.id != null ? String(inst.account.id) : null,
        accountType: inst.account?.type ?? null,
        appSlug: inst.app_slug ?? null,
        repositorySelection: inst.repository_selection ?? null,
      };

      if (action === "deleted" || action === "suspend") {
        // App uninstalled/suspended → record the lifecycle in the registry (the
        // system of record) AND pause its connections so they stop appearing
        // live and no further events are routed to them.
        await upsertGithubInstallation({
          installationId,
          ...meta,
          ...(action === "deleted" ? { deletedAt: now } : { suspendedAt: now }),
        });
        await pauseGithubConnections(installationId);
      } else {
        // created / unsuspend / new_permissions_accepted / repos added|removed →
        // the installation is live: refresh its registry metadata and clear any
        // prior suspend/uninstall. We deliberately do NOT auto-resume paused
        // connections — without a paused-reason column we cannot distinguish an
        // app-suspend pause from a user pause, so the user re-activates after an
        // unsuspend rather than risk silently un-pausing a user-paused connection.
        await upsertGithubInstallation({
          installationId,
          ...meta,
          reactivate: true,
        });
      }
    }

    return c.json({ received: true, lifecycle: eventName, action }, 200);
  }

  if (!installationId) {
    // No installation context to route on — ack so GitHub does not retry.
    return c.json({ received: true, dispatched: 0 }, 200);
  }

  // ── Resolve target connection(s) ──────────────────────────────────────────
  const repository = body["repository"] as
    | { full_name?: string }
    | null
    | undefined;
  const repoFullName = repository?.full_name ?? null; // "owner/repo"

  const rows = await withSystemDb((tx) =>
    tx
      .select({
        id: schema.sourceConnections.id,
        orgId: schema.sourceConnections.orgId,
        workspaceId: schema.sourceConnections.workspaceId,
        deliveryConfig: schema.sourceConnections.deliveryConfig,
      })
      .from(schema.sourceConnections)
      .where(
        and(
          eq(schema.sourceConnections.connectorId, "github"),
          eq(schema.sourceConnections.status, "connected"),
          sql`${schema.sourceConnections.deliveryConfig} ->> 'installationId' = ${installationId}`,
          isNull(schema.sourceConnections.deletedAt),
        ),
      ),
  );

  // A single installation can back many repo connections. Keep only the
  // connection(s) whose configured repo matches the event's repository.
  const targets = rows.filter((row) => {
    if (!repoFullName) return true; // org-level events (rare) fan out to all
    const dc = (row.deliveryConfig ?? {}) as Record<string, unknown>;
    const owner = typeof dc["owner"] === "string" ? dc["owner"] : "";
    const repo = typeof dc["repo"] === "string" ? dc["repo"] : "";
    return `${owner}/${repo}`.toLowerCase() === repoFullName.toLowerCase();
  });

  if (targets.length === 0) {
    return c.json({ received: true, dispatched: 0 }, 200);
  }

  // ── Extract ingestable records and fan out ────────────────────────────────
  const connector = getConnector("github");
  const extractions = connector.parseWebhookEvent?.(eventName, body) ?? [];

  const receivedAt = new Date().toISOString();
  const events: EntityReceivedEvent[] = [];
  for (const target of targets) {
    for (const ex of extractions) {
      events.push({
        name: "ingestion/entity.received",
        data: {
          connectionId: target.id,
          workspaceId: target.workspaceId,
          orgId: target.orgId,
          connectorType: "github",
          sourceRecordType: ex.sourceRecordType,
          idempotencyKey: `github:${target.id}:${eventName}:${ex.sourceRecordType}:${recordKey(ex.record)}`,
          payload: ex.record,
          receivedAt,
        },
      });
    }
  }

  // ── Canonical-ref projection trigger (push only) ──────────────────────────
  // Independent of the entity extraction above: a push with no ingestable
  // records still has to advance the projection. The delivery GUID rides along
  // as deliveryId — repository_ref_observations UNIQUEs on it, so GitHub's
  // at-least-once redelivery is idempotent. Whether this ref is canonical is
  // NOT decided here: repository-ref-updated compares it against the
  // repository's discovered default_ref.
  const refEvents: RefUpdatedEvent[] = [];
  const providerRepoIdRaw = (
    body["repository"] as { id?: number | string } | null | undefined
  )?.id;
  const deliveryId = c.req.header("x-github-delivery") ?? "";
  if (eventName === "push" && providerRepoIdRaw != null && deliveryId) {
    const ref = typeof body["ref"] === "string" ? body["ref"] : "";
    if (ref) {
      for (const target of targets) {
        const dc = (target.deliveryConfig ?? {}) as Record<string, unknown>;
        refEvents.push({
          name: "ingestion/repository.ref-updated",
          data: {
            orgId: target.orgId,
            workspaceId: target.workspaceId,
            connectionId: target.id,
            installationId,
            providerRepoId: String(providerRepoIdRaw),
            owner: typeof dc["owner"] === "string" ? dc["owner"] : "",
            repo: typeof dc["repo"] === "string" ? dc["repo"] : "",
            ref,
            beforeSha: pushSha(body["before"]),
            afterSha: pushSha(body["after"]),
            forced: body["forced"] === true,
            deleted: body["deleted"] === true,
            // One delivery can resolve to several connections; suffix the
            // connection so each gets its own dedupe row rather than all but
            // the first silently colliding on the UNIQUE delivery_id.
            deliveryId:
              targets.length > 1 ? `${deliveryId}:${target.id}` : deliveryId,
            observedAt: receivedAt,
          },
        });
      }
    }
  }

  if (events.length === 0 && refEvents.length === 0) {
    return c.json(
      { received: true, dispatched: 0, reason: "no_ingestable_records" },
      200,
    );
  }

  await eventClient.send([...events, ...refEvents]);

  return c.json(
    { received: true, dispatched: events.length, refUpdates: refEvents.length },
    200,
  );
});
