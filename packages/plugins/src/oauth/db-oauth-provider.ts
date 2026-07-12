/**
 * DbOAuthClientProvider — implements OAuthClientProvider from the MCP SDK,
 * backed by mcp.credentials (tokens + DCR client info, both encrypted) and
 * auth.verifications (ephemeral PKCE verifier + state, via the state store).
 *
 * One instance is constructed per OAuth session: (orgId, workspaceId,
 * orgListingId, redirectUrl, state).
 *
 * redirectToAuthorization() stores the URL on the instance (pendingRedirect)
 * so the authorize route can read it and redirect the browser.
 */
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  setWorkspaceSecret,
  getWorkspaceSecret,
} from "../credentials/workspace-credential";
import { saveOAuthState, loadOAuthState } from "./state-store";
import { preregisteredClientForEndpoint } from "./preregistered-clients";

export interface DbProviderCtx {
  orgId: string;
  workspaceId: string;
  orgListingId: string;
  /** The OAuth callback URL registered during DCR. */
  redirectUrl: string;
  /** OAuth state parameter (CSRF + PKCE store key). */
  state: string;
  /** Browser path to redirect back to after a successful callback. */
  returnTo: string;
  /** Displayed to the authorization server during DCR as the client name. */
  clientName: string;
  /** Returns current time in ms — injectable for testing. */
  now: () => number;
  /**
   * The MCP server's endpoint URL. When set, providers that do not support
   * RFC 7591 dynamic client registration (GitHub) can still authenticate via
   * a pre-registered client configured in MCP_OAUTH_PREREGISTERED_CLIENTS,
   * matched by this URL's host.
   */
  serverUrl?: string;
}

export class DbOAuthClientProvider implements OAuthClientProvider {
  /** Set by redirectToAuthorization(); the authorize route reads this to redirect the browser. */
  pendingRedirect: URL | null = null;

  /** In-session DCR client info cache — avoids repeated DB reads within a flow. */
  private clientInfoCache: OAuthClientInformationFull | null = null;

  constructor(private readonly c: DbProviderCtx) {}

  get redirectUrl(): string {
    return this.c.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.c.clientName,
      redirect_uris: [this.c.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    };
  }

  state(): string {
    return this.c.state;
  }

  // ── Client information (DCR result) ─────────────────────────────────────────

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    if (this.clientInfoCache) return this.clientInfoCache;
    const cred = await getWorkspaceSecret({
      orgId: this.c.orgId,
      workspaceId: this.c.workspaceId,
      orgListingId: this.c.orgListingId,
    });
    if (!cred?.oauthClientId) {
      // No DCR result stored. Fall back to a platform-level pre-registered
      // client (env-configured, matched by endpoint host) — the only way to
      // authenticate against authorization servers without a
      // registration_endpoint (GitHub). The SDK checks clientInformation()
      // before attempting DCR, so returning one here skips registration.
      if (this.c.serverUrl) {
        return preregisteredClientForEndpoint(this.c.serverUrl);
      }
      return undefined;
    }
    // Return the minimal OAuthClientInformation shape.
    const info: OAuthClientInformation = {
      client_id: cred.oauthClientId,
      ...(cred.oauthClientSecret
        ? { client_secret: cred.oauthClientSecret }
        : {}),
    };
    return info;
  }

  async saveClientInformation(
    info: OAuthClientInformationMixed,
  ): Promise<void> {
    // Cache full info for the lifetime of this provider instance.
    this.clientInfoCache = info as OAuthClientInformationFull;
    // Persist to mcp.credentials (oauthClientId plain, oauthClientSecret encrypted).
    await setWorkspaceSecret({
      orgId: this.c.orgId,
      workspaceId: this.c.workspaceId,
      orgListingId: this.c.orgListingId,
      authKind: "oauth",
      oauthClientId: info.client_id,
      oauthClientSecret: info.client_secret ?? null,
    });
  }

  // ── Tokens ──────────────────────────────────────────────────────────────────

  async tokens(): Promise<OAuthTokens | undefined> {
    const cred = await getWorkspaceSecret({
      orgId: this.c.orgId,
      workspaceId: this.c.workspaceId,
      orgListingId: this.c.orgListingId,
    });
    if (!cred?.accessToken) return undefined;
    const tokens: OAuthTokens = {
      access_token: cred.accessToken,
      token_type: "Bearer",
      ...(cred.refreshToken ? { refresh_token: cred.refreshToken } : {}),
    };
    return tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    // Persist the absolute expiry so the proactive-refresh watcher
    // (plugin.oauth-refresh-watcher) can select this credential BEFORE its
    // access token lapses. Without this, expires_at stays NULL, `expires_at <
    // now() + interval` never matches, and proactive refresh silently never
    // runs — leaving only reactive 401-driven refresh. `expires_in` is seconds
    // from now per RFC 6749 §5.1; a refresh with no expires_in clears the
    // stored expiry (null) rather than preserving a stale one.
    const now = this.c.now();
    const expiresAt =
      typeof tokens.expires_in === "number" && tokens.expires_in > 0
        ? new Date(now + tokens.expires_in * 1000)
        : null;
    await setWorkspaceSecret({
      orgId: this.c.orgId,
      workspaceId: this.c.workspaceId,
      orgListingId: this.c.orgListingId,
      authKind: "oauth",
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiresAt,
      lastRefreshedAt: new Date(now),
    });
  }

  // ── Authorization redirect ───────────────────────────────────────────────────

  async redirectToAuthorization(url: URL): Promise<void> {
    this.pendingRedirect = url;
  }

  // ── PKCE code verifier (via state store) ────────────────────────────────────

  async saveCodeVerifier(verifier: string): Promise<void> {
    await saveOAuthState(
      this.c.state,
      {
        codeVerifier: verifier,
        orgId: this.c.orgId,
        workspaceId: this.c.workspaceId,
        orgListingId: this.c.orgListingId,
        returnTo: this.c.returnTo,
      },
      this.c.now(),
    );
  }

  async codeVerifier(): Promise<string> {
    const s = await loadOAuthState(this.c.state, this.c.now());
    if (!s) throw new Error("[mcp-oauth] code verifier expired or missing");
    return s.codeVerifier;
  }
}
