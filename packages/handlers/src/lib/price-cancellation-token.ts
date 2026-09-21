import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { requireEnv } from "@oxagen/config/env";
import { HandlerError } from "@oxagen/oxagen";
import { z } from "zod";

const payloadSchema = z
  .object({
    id: z.string().uuid(),
    orgId: z.string().uuid(),
    provider: z.string(),
    model: z.string(),
    tokenClass: z.string(),
    region: z.string().nullable(),
    source: z.literal("negotiated"),
    effectiveFrom: z.string().datetime(),
  })
  .strict();
type Payload = z.infer<typeof payloadSchema>;
const key = (secret: string) =>
  createHash("sha256")
    .update("oxagen:price-cancellation:v1\0")
    .update(secret)
    .digest();
const secretFromEnv = () =>
  requireEnv(["BETTER_AUTH_SECRET"] as const).BETTER_AUTH_SECRET;

/** Keep the database ID inside an authenticated, opaque management token. */
export function sealPriceCancellation(
  payload: Payload,
  secret = secretFromEnv(),
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(payloadSchema.parse(payload)), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

export function openPriceCancellation(
  token: string,
  secret = secretFromEnv(),
): Payload {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(token) || token.length > 4096)
      throw new Error("invalid token");
    const bytes = Buffer.from(token, "base64url");
    if (bytes.toString("base64url") !== token || bytes.length <= 28)
      throw new Error("invalid token");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key(secret),
      bytes.subarray(0, 12),
    );
    decipher.setAuthTag(bytes.subarray(12, 28));
    return payloadSchema.parse(
      JSON.parse(
        Buffer.concat([
          decipher.update(bytes.subarray(28)),
          decipher.final(),
        ]).toString("utf8"),
      ),
    );
  } catch {
    throw new HandlerError({
      code: "conflict",
      reason: "price_cancellation_invalid",
      message:
        "This cancellation token is invalid. Refresh the price book and try again.",
    });
  }
}
