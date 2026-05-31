import { apiKeyAuthMiddleware, type Middleware } from "xmcp";

// Phase 1: API-key gate using the same env var as the API surface.
// Phase 2: Replace with JWT middleware once the IAM subagent lands.
export default apiKeyAuthMiddleware({
  headerName: "x-api-key",
  validateApiKey: async (apiKey) => {
    // TODO(auth): validate against @oxagen/database api_keys table
    return apiKey === process.env.MCP_API_KEY;
  },
}) satisfies Middleware;
