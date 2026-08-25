/**
 * GitHub App webhook receiver.
 *
 * A GitHub App has a single, global webhook URL — every event for every
 * installation is delivered here. That is why this route is App-level
 * (`POST /webhooks/github/app`) and resolves the target connection(s) from the
 * payload's `installation.id` + `repository.full_name`, rather than from a
 * per-connection path segment like the generic `/webhooks/:connector/:conn` route.
 *
 * Security boundary: HMAC-SHA256 over the raw body, verified against the
 * secret belonging to the App that SENT the delivery, using the
 * `x-hub-signature-256` header. There is no HTTP auth on this route.
 *
 * Two Apps deliver here. `oxagen-code-agent` signs with
 * `GITHUB_APP_WEBHOOK_SECRET`; a second App, `oxagen-sh`, signs with
 * `GITHUB_WEBHOOK_SECRET` — confirmed by HMAC-verifying a captured delivery
 * (#1200), which is why that parameter existed in Parameter Store while no
 * code read it. Every one of its deliveries was rejected 401.
 *
 * The sender is identified by `x-github-hook-installation-target-id`, and each
 * App is verified against its OWN secret — not against whichever one happens to
 * match, which would let either secret authorise a payload claiming to be from
 * the other.
 *
 * Flow:
 *   1. Verify the signature against GITHUB_APP_WEBHOOK_SECRET.
 *   2. `ping` → ack. `installation` / `installation_repositories` → reconcile
 *      (pause connections on uninstall/suspend), ack.
 *   3. Resolve connected GitHub connection(s) for this installation + repo.
 *   4. Ask the connector to extract ingestable (sourceRecordType, record) pairs.
 *   5. Fan out one `ingestion/entity.received` per (connection × record). The
 *      6-step pipeline then maps/dedups/embeds exactly as the initial sync does.
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

function verifySignature(
  payload: Uint8Array,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
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
  if (typeof r["id"] === "number" || typeof r["id"] === "string") return String(r["id"]);
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
  const {
    GITHUB_APP_WEBHOOK_SECRET: appSecret,
    GITHUB_WEBHOOK_SECRET: secondAppSecret,
    GITHUB_APP_ID: appId,
  } = requireEnv([
    "GITHUB_APP_WEBHOOK_SECRET",
    "GITHUB_WEBHOOK_SECRET",
    "GITHUB_APP_ID",
  ] as const);

  // Pick the secret by SENDER. A delivery from the primary App is verified
  // against the primary secret and nothing else; anything else that arrives
  // here is verified against the second App's secret, when one is configured.
  const targetId = c.req.header("x-github-hook-installation-target-id");
  const fromPrimaryApp = !targetId || (!!appId && targetId === appId);
  const secret = fromPrimaryApp ? appSecret : secondAppSecret;

  if (!secret && !fromPrimaryApp) {
    // A second App is delivering and we hold no secret for it. Ack so GitHub
    // stops retrying — the same reasoning as the branch below — and name the
    // sender so this is one log line rather than an investigation.
    logger.error(
      { reason: "webhook_secret_missing_for_sender", targetId },
      "GitHub App webhook from an App this deployment holds no secret for — " +
        "acking with 200 to stop retries; set GITHUB_WEBHOOK_SECRET for it",
    );
    return c.json(
      { received: true, dispatched: 0, reason: "no secret for sender" },
      200,
    );
  }

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
      { received: true, dispatched: 0, reason: "webhook secret not configured" },
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
    body = JSON.parse(Buffer.from(payload).toString("utf8")) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON payload" }, 400);
  }

  // Webhook creation handshake — GitHub sends this once when the hook is added.
  if (eventName === "ping") {
    return c.json({ received: true, pong: true }, 200);
  }

  const installation = body["installation"] as { id?: number | string } | null | undefined;
  const installationId =
    installation && installation.id != null ? String(installation.id) : null;

  // ── Installation lifecycle ────────────────────────────────────────────────
  // GitHub delivers these to the App webhook automatically (no subscription).
  if (eventName === "installation" || eventName === "installation_repositories") {
    const action = typeof body["action"] === "string" ? body["action"] : "";
    const now = new Date();

    if (installationId) {
      // The installation payload (present on both event types) carries the
      // account + app details we keep in the registry.
      const inst = (body["installation"] ?? {}) as {
        account?: { login?: string; id?: number | string; type?: string } | null;
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
        await upsertGithubInstallation({ installationId, ...meta, reactivate: true });
      }
    }

    return c.json({ received: true, lifecycle: eventName, action }, 200);
  }

  if (!installationId) {
    // No installation context to route on — ack so GitHub does not retry.
    return c.json({ received: true, dispatched: 0 }, 200);
  }

  // ── Resolve target connection(s) ──────────────────────────────────────────
  const repository = body["repository"] as { full_name?: string } | null | undefined;
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
  if (extractions.length === 0) {
    return c.json({ received: true, dispatched: 0, reason: "no_ingestable_records" }, 200);
  }

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

  await eventClient.send(events);

  return c.json({ received: true, dispatched: events.length }, 200);
});
