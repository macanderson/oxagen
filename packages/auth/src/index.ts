export { auth } from "./auth";
export type { Auth, Session } from "./auth";
export {
  authClient,
  signIn,
  signOut,
  signUp,
  useSession,
  getSession,
} from "./client";

// Env predicate — mirrors auth.ts requireEmailVerification gating. Surface for
// callers (e.g. apps/api /health) that need to evaluate the same condition
// without re-deriving it.
export { isEmailVerificationRequired, resolveIsLocalEnv } from "./local-env";
export type { LocalEnvSignals } from "./local-env";

// Transport-agnostic identity resolvers — §7.3 thin-wrapper surface.
// API, MCP, and CLI call these; HTTP/transport specifics live in each
// surface's thin wrapper.
export type { SessionResult } from "./resolvers/index";
export {
  resolveSession,
  parseSessionCookie,
  stripCookieSignature,
  SESSION_COOKIE_NAME,
} from "./resolvers/index";

export type {
  ApiKeyResult,
  ApiKeyResolutionError,
  ApiKeyResolution,
} from "./resolvers/index";
export {
  resolveApiKey,
  apiKeyPrefix,
  API_KEY_PREFIX_LENGTH,
  API_KEY_RAW_PREFIX,
} from "./resolvers/index";

export type {
  OrgScopeResult,
  OrgScopeResolutionError,
  OrgScopeResolution,
} from "./resolvers/index";
export { resolveOrgScope } from "./resolvers/index";

export type {
  WorkspaceScopeResult,
  WorkspaceScopeResolution,
} from "./resolvers/index";
export { resolveWorkspaceScope } from "./resolvers/index";
