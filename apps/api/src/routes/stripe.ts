import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { processStripeEvent, verifyStripeSignature } from "@oxagen/billing";
import { logger } from "../middleware/logger";
import type { AppEnv } from "../app";

export const stripeWebhook = new Hono<AppEnv>();

stripeWebhook.post("/", async (c) => {
  const signature = c.req.header("stripe-signature");
  if (!signature)
    throw new HTTPException(400, { message: "Missing stripe-signature" });

  // Stripe demands the *raw* request body for signature verification —
  // Hono's c.req.text() preserves bytes without JSON re-serialization.
  const rawBody = await c.req.text();

  let event;
  try {
    event = verifyStripeSignature(rawBody, signature);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "signature verification failed";
    logger.warn({ err: message }, "stripe webhook signature rejected");
    throw new HTTPException(400, { message });
  }

  const result = await processStripeEvent(event);
  logger.info(
    { eventId: event.providerEventId, type: event.type, status: result.status },
    "stripe webhook processed",
  );
  return c.json({ received: true, status: result.status });
});
