/**
 * Linear OAuth app webhook receiver.
 *
 * The Linear OAuth app has one webhook URL for every workspace that installs
 * it, so this route is app-level (`POST /webhooks/linear`), like the GitHub
 * App's. Linear signs each delivery with the app's signing secret: the
 * `Linear-Signature` header is a hex HMAC-SHA256 of the raw body.
 *
 * Nothing consumes the deliveries yet. They belong to the collector framework
 * (#4775) and a Linear collector, which will store and map them. Until then the
 * route verifies each delivery and answers 200, because Linear retries a failed
 * delivery three times and may then disable the webhook (#4881).
 */
import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { requireEnv } from "@oxagen/config/env";
import { logger } from "../../middleware/logger";
import type { AppEnv } from "../../app";

/**
 * Linear's guidance: refuse a delivery whose `webhookTimestamp` is more than a
 * minute from now, so a captured delivery cannot be replayed later.
 */
export const LINEAR_WEBHOOK_MAX_SKEW_MS = 60_000;

export function verifyLinearSignature(
  payload: Uint8Array,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = Buffer.from(
    createHmac("sha256", secret).update(payload).digest("hex"),
    "utf8",
  );
  const got = Buffer.from(signatureHeader, "utf8");
  // timingSafeEqual throws on a length mismatch, so compare lengths first.
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

export const linearWebhookRoute = new Hono<AppEnv>();

linearWebhookRoute.post("/", async (c) => {
  const { LINEAR_WEBHOOK_SECRET: secret } = requireEnv([
    "LINEAR_WEBHOOK_SECRET",
  ] as const);

  if (!secret) {
    // A missing secret is a deploy mistake the sender cannot fix. Any non-200
    // counts as a failed delivery and can get the webhook disabled, so ack and
    // log. Nothing is stored, so acking an unverified delivery changes nothing.
    logger.error(
      { reason: "linear_webhook_secret_missing" },
      "Linear webhook received but LINEAR_WEBHOOK_SECRET is not set. Acking with 200 so Linear keeps the webhook enabled.",
    );
    return c.json(
      { received: true, reason: "webhook secret not configured" },
      200,
    );
  }

  // The HMAC covers the exact bytes, so read the raw body before parsing.
  const payload = new Uint8Array(await c.req.arrayBuffer());
  if (
    !verifyLinearSignature(payload, c.req.header("linear-signature"), secret)
  ) {
    return c.json({ error: "Webhook signature invalid" }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(Buffer.from(payload).toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return c.json({ error: "Invalid JSON payload" }, 400);
  }

  const sentAt = body["webhookTimestamp"];
  if (
    typeof sentAt !== "number" ||
    Math.abs(Date.now() - sentAt) > LINEAR_WEBHOOK_MAX_SKEW_MS
  ) {
    return c.json(
      { error: "Webhook timestamp outside the allowed window" },
      401,
    );
  }

  logger.info(
    {
      delivery: c.req.header("linear-delivery") ?? null,
      event: c.req.header("linear-event") ?? null,
      action: typeof body["action"] === "string" ? body["action"] : null,
      linearOrganizationId:
        typeof body["organizationId"] === "string"
          ? body["organizationId"]
          : null,
    },
    "Linear webhook delivery verified. No collector consumes it yet (#4775).",
  );
  return c.json({ received: true }, 200);
});
