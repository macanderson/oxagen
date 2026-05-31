export { auth } from "./auth.js";
export type { Auth, Session } from "./auth.js";
export { authClient, signIn, signOut, signUp, useSession, getSession } from "./client.js";

// Transport-agnostic identity resolvers — §7.3 thin-wrapper surface.
// API, MCP, and CLI call these; HTTP/transport specifics live in each
// surface's thin wrapper.
export type { SessionResult } from "./resolvers/index.js";
export { resolveSession, parseSessionCookie } from "./resolvers/index.js";

export type {
  ApiKeyResult,
  ApiKeyResolutionError,
  ApiKeyResolution,
} from "./resolvers/index.js";
export { resolveApiKey } from "./resolvers/index.js";

export type {
  OrgScopeResult,
  OrgScopeResolutionError,
  OrgScopeResolution,
} from "./resolvers/index.js";
export { resolveOrgScope } from "./resolvers/index.js";

export type { WorkspaceScopeResult, WorkspaceScopeResolution } from "./resolvers/index.js";
export { resolveWorkspaceScope } from "./resolvers/index.js";
