import { createHash } from "node:crypto";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { tachoHostEnroll } from "@oxagen/oxagen/contracts/tacho.host.enroll";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import {
  distributedRateLimiter,
  trustedClientIpBucketKey,
} from "../../middleware/distributed-rate-limit";
import type { AppEnv } from "../../app";

/**
 * Enrol a machine with a single-use enrollment token.
 *
 * Public: the machine holds no session and no API key yet, so this route is
 * mounted before the auth-gated /v1/tacho group, the way /v1/auth/cli is. The
 * token in the body is the security boundary (single use, short-lived, stored
 * as a digest). The route has its own pre-auth ceilings, mounted before the
 * /v1/tacho/* ones in app.ts: a call with no Authorization header lands in
 * one shared credential bucket there, which would let any caller hold
 * enrollment closed for every tenant.
 */
const MAX_BODY_BYTES = 65536;
/** Presentations of one token per minute; a real installer presents once. */
const ENROLL_PER_TOKEN_PER_MIN = 5;
/** Presentations from one client address per minute (a fleet rollout behind one NAT). */
const ENROLL_PER_IP_PER_MIN = 120;
/** Domain separator, so the bucket digest is unrelated to the token's stored digest. */
const TOKEN_FINGERPRINT_DOMAIN = "oxagen:ratelimit:enrollment-token:v1\0";

/**
 * The digest of the token in the body. A body with no readable token shares
 * one bucket, which only callers that send no token can fill. Hono caches the
 * parsed body, so the route reads the same value (or the same parse error).
 */
async function enrollmentTokenBucketKey(c: Context<AppEnv>): Promise<string> {
  let token = "";
  try {
    const body: unknown = await c.req.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "token" in body &&
      typeof body.token === "string"
    ) {
      token = body.token;
    }
  } catch {
    // An unreadable body keeps the empty token; the route answers 400.
  }
  const fingerprint = createHash("sha256")
    .update(TOKEN_FINGERPRINT_DOMAIN)
    .update(token)
    .digest("hex");
  return `token:${fingerprint}`;
}

export const tachoHostEnrollRoute = new Hono<AppEnv>();

tachoHostEnrollRoute.use(
  "*",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => {
      throw new HTTPException(413, { message: "Payload Too Large" });
    },
  }),
);
// Both ceilings degrade to the per-instance limiter rather than denying when
// the counter store is unreachable (ADR-082). The reasoning that applies to the
// other pre-auth mounts applies here unchanged: these counters live in the same
// Postgres that validates the enrollment token, so a store failure that would
// have tripped a fail-closed deny has already taken the thing the deny was
// protecting — while a counter statement that breaks on its own would have
// taken enrollment offline for everyone, which is how #3167 started.
tachoHostEnrollRoute.use(
  "*",
  distributedRateLimiter({
    keyPrefix: "tacho-enroll-ip",
    max: ENROLL_PER_IP_PER_MIN,
    bucketKey: trustedClientIpBucketKey,
    methods: "all",
    storeErrorPolicy: "degrade-to-local",
  }),
);
tachoHostEnrollRoute.use(
  "*",
  distributedRateLimiter({
    keyPrefix: "tacho-enroll-token",
    max: ENROLL_PER_TOKEN_PER_MIN,
    bucketKey: enrollmentTokenBucketKey,
    methods: "all",
    storeErrorPolicy: "degrade-to-local",
  }),
);

tachoHostEnrollRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = tachoHostEnroll.input.parse(rawInput);
  const ctx = capabilityContext(c, { requireOrg: false });
  const output = await invoke(tachoHostEnroll.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 201);
});
