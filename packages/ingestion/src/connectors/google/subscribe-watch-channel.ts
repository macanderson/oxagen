import { randomBytes, randomUUID } from "node:crypto";
import type { AuthCredential, WebhookSubscriptionResult } from "../types";

// Shared Google "watch channel" subscription helper for the Drive/Gmail/Calendar
// connectors. Google push notifications do not carry an HMAC; instead the value
// passed as `token` at watch-creation time is echoed back verbatim in the
// X-Goog-Channel-Token header on every delivery (see verify-channel-token.ts).
// So the channel token IS the shared secret, and verifyWebhook compares it in
// constant time.
//
// Each *.watch endpoint takes the same channel body shape:
//   { id, type: "web_hook", address: <webhookUrl>, token: <secret>, expiration }
// and returns { id, resourceId, expiration }. `expiration` is epoch millis as a
// string. We request the provider's max and let the renewal cron re-watch
// before it lapses (Drive/Calendar ~7d, Gmail ~7d via Pub/Sub).

/** Resolve a usable bearer token from the resolved connection credential. */
export function googleBearerToken(auth: AuthCredential): string | null {
  return auth.scheme === "bearer_token" ? auth.token : null;
}

interface WatchChannelResponse {
  id?: unknown;
  resourceId?: unknown;
  expiration?: unknown;
}

/**
 * POST a Google *.watch request and translate the response into the shared
 * WebhookSubscriptionResult. `connectorLabel` names the caller for error text;
 * `watchUrl` is the fully-qualified endpoint; `extraBody` carries any endpoint-
 * specific fields (e.g. Gmail's topicName / labelIds).
 */
export async function subscribeGoogleWatchChannel(args: {
  connectorLabel: string;
  auth: AuthCredential;
  watchUrl: string;
  webhookUrl: string;
  recordTypes: readonly string[];
  extraBody?: Record<string, unknown>;
  // Google caps channel lifetime; request this many ms out (clamped by Google).
  ttlMs?: number;
}): Promise<WebhookSubscriptionResult> {
  const token = googleBearerToken(args.auth);
  if (!token) {
    throw new Error(
      `${args.connectorLabel}.subscribeWebhooks: connection has no usable bearer token`,
    );
  }

  // The channel token is the shared secret verifyWebhook checks. 32 random
  // bytes, base64url — under Google's 256-byte channel-token limit.
  const channelToken = randomBytes(32).toString("base64url");
  const ttlMs = args.ttlMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days
  const expiration = Date.now() + ttlMs;

  const resp = await fetch(args.watchUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: randomUUID(),
      type: "web_hook",
      address: args.webhookUrl,
      token: channelToken,
      expiration: String(expiration),
      ...args.extraBody,
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(
      `${args.connectorLabel}.subscribeWebhooks: ${args.watchUrl} failed (${resp.status}): ${detail.slice(0, 200)}`,
    );
  }

  const body = (await resp.json()) as WatchChannelResponse;
  // Google returns `id` (our channel id) and `resourceId` (the watched resource).
  // We persist resourceId as the provider subscription id — it is the handle
  // needed to stop()/renew the channel.
  const providerSubscriptionId =
    typeof body.resourceId === "string"
      ? body.resourceId
      : typeof body.id === "string"
        ? body.id
        : "";
  // `expiration` comes back as epoch-millis string; prefer it over our request.
  const expiresAt =
    typeof body.expiration === "string" && /^\d+$/.test(body.expiration)
      ? new Date(Number(body.expiration))
      : new Date(expiration);

  return {
    subscriptionId: providerSubscriptionId,
    secret: channelToken,
    expiresAt,
    recordTypes: args.recordTypes,
    hmacHeader: "x-goog-channel-token",
    hmacAlgorithm: "channel_token",
  };
}
