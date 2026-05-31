import { createHash, timingSafeEqual } from "node:crypto";
import { apiKeyAuthMiddleware, type Middleware } from "xmcp";

// Fail loud at startup if the gate secret is missing. Without this, an unset
// MCP_API_KEY makes the comparison `apiKey === undefined` (always false), so
// every request is silently rejected with no obvious configuration cause.
const MCP_API_KEY = process.env.MCP_API_KEY;
if (!MCP_API_KEY) {
  throw new Error(
    "MCP_API_KEY is not set — the MCP API-key gate cannot operate. " +
      "Set MCP_API_KEY before starting the server.",
  );
}

// Pre-hash the expected key once. Hashing both sides to fixed-length (32-byte)
// SHA-256 digests lets timingSafeEqual run in constant time and never throw on
// a length mismatch, closing the timing side-channel of a raw `===` compare.
const EXPECTED_KEY_DIGEST = createHash("sha256").update(MCP_API_KEY).digest();

// Phase 1: API-key gate using the same env var as the API surface.
// Phase 2: Replace with @oxagen/auth resolveApiKey once per-tenant MCP keys land.
export default apiKeyAuthMiddleware({
  headerName: "x-api-key",
  validateApiKey: async (apiKey) => {
    if (typeof apiKey !== "string" || apiKey.length === 0) return false;
    const candidateDigest = createHash("sha256").update(apiKey).digest();
    return timingSafeEqual(candidateDigest, EXPECTED_KEY_DIGEST);
  },
}) satisfies Middleware;
