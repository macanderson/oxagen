// api-key-gate.ts: the transport's auth gate, the first middleware xmcp runs.
//
// It turns away any request without a well-formed `Authorization: Bearer
// <token>` before a route or tool runs, with the answer xmcp's
// apiKeyAuthMiddleware gave, word for word. That helper is not imported
// because it lives in xmcp's package root. Importing a value from the root
// pulls xmcp's HTTP runtime into dist/http.js, and that runtime reads
// HTTP_CORS_* constants that only xmcp's own entry defines. The build then
// threw `ReferenceError: HTTP_CORS_ORIGIN is not defined` at startup, and
// every production mcp deploy failed its health check (#4829).
import type { RequestHandler } from "express";
import { extractBearerToken } from "./context";

/** The body xmcp's apiKeyAuthMiddleware answered with. Callers may match on it. */
export const API_KEY_REFUSAL = "Unauthorized: Missing or invalid API key";

export const apiKeyGate: RequestHandler = (req, res, next) => {
  if (extractBearerToken(req.header("authorization")) === null) {
    res.status(401).json({ error: API_KEY_REFUSAL });
    return;
  }
  next();
};
