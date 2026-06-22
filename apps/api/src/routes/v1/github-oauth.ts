/**
 * GitHub App OAuth routes.
 *
 * Mounted at /v1/:org_slug/:workspace_slug/connections/github/* (auth-required)
 * and at /oauth/github/callback (public — HMAC-verified OAuth state param is
 * the security boundary here, not HTTP auth).
 *
 * Flow:
 *   1. Client POSTs /connections to create a pending_setup source_connection row.
 *   2. Client GETs /connections/github/auth-url?connectionId={publicId} →
 *      receives a signed GitHub OAuth URL. Navigates user there.
 *   3. GitHub redirects back to GET /oauth/github/callback?code=…&state=…
 *      The route verifies the state HMAC, exchanges the code, encrypts + stores
 *      the token, and redirects the user back to the app.
 *   4. Client GETs /connections/github/installations?connectionId={publicId}
 *      to list orgs the user granted the App access to.
 *   5. Client GETs /connections/github/installations/:id/repositories?connectionId={publicId}
 *      to pick repos.
 *   6. Client PUTs /connections/:id/mappings to save the selection and trigger sync.
 */

import { Hono } from "hono";
import { createHmac } from "node:crypto";
import { schema, withSystemDb, withTenantDb } from "@oxagen/database";
import { encrypt, decrypt, createIngestionCryptoAdapter } from "@oxagen/crypto";
import { and, eq, isNull } from "drizzle-orm";
import { runInTenantScope } from "@oxagen/tenancy";
import type { AppEnv } from "../../app";
import { requireEnv } from "@oxagen/config/env";

/**
 * Authenticated github-oauth sub-routes.
 * Must be mounted inside the workspace-scoped middleware group so that
 * orgId / workspaceId are already set on the context.
 */
export const githubOauthRoute = new Hono<AppEnv>();

// ── helpers ───────────────────────────────────────────────────────────────────

function buildStateHmac(stateJson: string, secret: string): string {
  return createHmac("sha256", secret).update(stateJson).digest("hex");
}

function encodeState(stateJson: string): string {
  return Buffer.from(stateJson).toString("base64url");
}

function decodeState(encoded: string): string {
  return Buffer.from(encoded, "base64url").toString("utf8");
}

/**
 * Decrypt an access token stored as { keyId, ciphertext } JSON payload.
 */
async function decryptToken(enc: { keyId: string; ciphertext: string }): Promise<string> {
  const { adapter } = createIngestionCryptoAdapter();
  const plain = await decrypt(Buffer.from(enc.ciphertext, "base64"), enc.keyId, { adapter });
  return plain.toString("utf8");
}

/**
 * Build the GitHub URL that lets a user add/remove which orgs and repos the
 * Oxagen GitHub App is installed into.
 *
 * Prefers the canonical GITHUB_APP_SLUG env (works even when the user currently
 * has zero installations), falls back to the slug reported on an existing
 * installation, and finally to GitHub's generic installed-apps settings page so
 * the link is always actionable.
 */
function buildManageInstallationsUrl(
  configuredSlug: string | undefined,
  installations: GitHubInstallation[],
): string {
  const slug = configuredSlug?.trim() || installations.find((i) => i.app_slug)?.app_slug;
  return slug
    ? `https://github.com/apps/${slug}/installations/new`
    : "https://github.com/settings/installations";
}

// ── GET /connections/github/auth-url ─────────────────────────────────────────

/**
 * Generate a signed GitHub OAuth authorization URL.
 *
 * Query params:
 *   connectionId  — publicId of the pre-created source_connection row
 *
 * Returns:
 *   { authUrl: string }
 */
githubOauthRoute.get("/auth-url", async (c) => {
  const env = requireEnv([
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_INSTALL_STATE_SECRET",
    "NEXT_PUBLIC_API_URL",
  ] as const);

  const connectionId = c.req.query("connectionId");
  if (!connectionId) {
    return c.json({ error: "connectionId query param is required" }, 400);
  }

  const orgId = c.get("orgId");
  const workspaceId = c.get("workspaceId");
  if (!orgId || !workspaceId) {
    return c.json({ error: "Org/workspace scope required" }, 400);
  }

  const clientId = env.GITHUB_APP_CLIENT_ID;
  const stateSecret = env.GITHUB_APP_INSTALL_STATE_SECRET;

  if (!clientId || !stateSecret) {
    return c.json(
      { error: "GitHub App is not configured — GITHUB_APP_CLIENT_ID / GITHUB_APP_INSTALL_STATE_SECRET missing" },
      503,
    );
  }

  const stateJson = JSON.stringify({
    orgId,
    workspaceId,
    connectionId,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
    nonce: crypto.randomUUID(),
  });

  const hmac = buildStateHmac(stateJson, stateSecret);
  const encodedState = encodeState(stateJson);

  // Callback URL registered in the GitHub App settings.
  const callbackUrl = `${env.NEXT_PUBLIC_API_URL}/oauth/github/callback`;

  const authUrl =
    `https://github.com/login/oauth/authorize` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&scope=repo%2Cread%3Aorg` +
    `&state=${encodeURIComponent(`${encodedState}.${hmac}`)}` +
    `&redirect_uri=${encodeURIComponent(callbackUrl)}`;

  return c.json({ authUrl });
});

// ── GET /connections/github/installations ─────────────────────────────────────

interface GitHubInstallation {
  id: number;
  account: {
    login: string;
    type: string;
    avatar_url: string;
  };
  repository_selection: string;
  /** App-specific page where the user manages this installation's org/repo access. */
  html_url?: string;
  /** Public slug of the GitHub App (path segment in github.com/apps/<slug>). */
  app_slug?: string;
}

interface GitHubInstallationsResponse {
  total_count: number;
  installations: GitHubInstallation[];
}

/**
 * List GitHub App installations accessible to the OAuth-authed user.
 *
 * Query params:
 *   connectionId — publicId of the source_connection (used to look up the token)
 *
 * Returns:
 *   { installations: [{ id, accountLogin, accountType, repositorySelection, avatarUrl }] }
 */
githubOauthRoute.get("/installations", async (c) => {
  const connectionPublicId = c.req.query("connectionId");
  if (!connectionPublicId) {
    return c.json({ error: "connectionId query param is required" }, 400);
  }

  const orgId = c.get("orgId");
  const workspaceId = c.get("workspaceId");
  if (!orgId || !workspaceId) {
    return c.json({ error: "Org/workspace scope required" }, 400);
  }

  // Look up the OAuth account linked to this connection.
  const rows = await runInTenantScope({ orgId, workspaceId }, () =>
    withTenantDb((tx) =>
      tx
        .select({
          accessTokenEnc: schema.oauthAccounts.accessTokenEnc,
        })
        .from(schema.sourceConnections)
        .innerJoin(
          schema.oauthAccounts,
          eq(schema.oauthAccounts.id, schema.sourceConnections.oauthAccountId),
        )
        .where(
          and(
            eq(schema.sourceConnections.publicId, connectionPublicId),
            eq(schema.sourceConnections.orgId, orgId),
            eq(schema.sourceConnections.workspaceId, workspaceId),
            isNull(schema.sourceConnections.deletedAt),
          ),
        )
        .limit(1),
    ),
  );

  const row = rows[0];
  if (!row) {
    return c.json({ error: "Connection not found or OAuth token missing" }, 404);
  }

  const tokenEnc = row.accessTokenEnc as { keyId: string; ciphertext: string } | null;
  if (!tokenEnc) {
    return c.json({ error: "OAuth token not found for connection" }, 404);
  }

  let accessToken: string;
  try {
    accessToken = await decryptToken(tokenEnc);
  } catch (_e) {
    return c.json(
      { error: "Failed to decrypt OAuth token — token may be corrupted or the encryption key is unavailable" },
      500,
    );
  }

  // Page through all installations (GitHub paginates at 100/page).
  const allInstallations: GitHubInstallation[] = [];
  let page = 1;
  let totalCount = 0;

  do {
    const resp = await fetch(
      `https://api.github.com/user/installations?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "oxagen-ingestion/1.0",
        },
      },
    );

    if (!resp.ok) {
      return c.json(
        { error: `GitHub API returned ${resp.status} when listing installations` },
        502,
      );
    }

    const data = (await resp.json()) as GitHubInstallationsResponse;
    totalCount = data.total_count;
    allInstallations.push(...data.installations);
    page++;
  } while (allInstallations.length < totalCount);

  const { GITHUB_APP_SLUG } = requireEnv(["GITHUB_APP_SLUG"] as const);

  return c.json({
    // Top-level link to GitHub's install/configure page so the user can add the
    // App to another org (or remove one) and have it appear after a refresh.
    manageUrl: buildManageInstallationsUrl(GITHUB_APP_SLUG, allInstallations),
    installations: allInstallations.map((inst) => ({
      id: inst.id,
      accountLogin: inst.account.login,
      accountType: inst.account.type,
      repositorySelection: inst.repository_selection,
      avatarUrl: inst.account.avatar_url,
      // Per-installation page for managing which repos this org grants access to.
      htmlUrl: inst.html_url ?? null,
    })),
  });
});

// ── GET /connections/github/installations/:installationId/repositories ────────

interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  language: string | null;
  description: string | null;
}

interface GitHubRepositoriesResponse {
  total_count: number;
  repositories: GitHubRepository[];
}

/**
 * List repositories for a specific GitHub App installation.
 *
 * Path params:
 *   installationId — GitHub App installation ID
 * Query params:
 *   connectionId — publicId of the source_connection (used to look up the token)
 *
 * Returns:
 *   { repositories: [...], totalCount: number }
 */
githubOauthRoute.get("/installations/:installationId/repositories", async (c) => {
  const installationId = c.req.param("installationId");
  const connectionPublicId = c.req.query("connectionId");

  if (!connectionPublicId) {
    return c.json({ error: "connectionId query param is required" }, 400);
  }

  const orgId = c.get("orgId");
  const workspaceId = c.get("workspaceId");
  if (!orgId || !workspaceId) {
    return c.json({ error: "Org/workspace scope required" }, 400);
  }

  // Same token lookup as /installations.
  const rows = await runInTenantScope({ orgId, workspaceId }, () =>
    withTenantDb((tx) =>
      tx
        .select({
          accessTokenEnc: schema.oauthAccounts.accessTokenEnc,
        })
        .from(schema.sourceConnections)
        .innerJoin(
          schema.oauthAccounts,
          eq(schema.oauthAccounts.id, schema.sourceConnections.oauthAccountId),
        )
        .where(
          and(
            eq(schema.sourceConnections.publicId, connectionPublicId),
            eq(schema.sourceConnections.orgId, orgId),
            eq(schema.sourceConnections.workspaceId, workspaceId),
            isNull(schema.sourceConnections.deletedAt),
          ),
        )
        .limit(1),
    ),
  );

  const row = rows[0];
  if (!row) {
    return c.json({ error: "Connection not found or OAuth token missing" }, 404);
  }

  const tokenEnc = row.accessTokenEnc as { keyId: string; ciphertext: string } | null;
  if (!tokenEnc) {
    return c.json({ error: "OAuth token not found for connection" }, 404);
  }

  let accessToken: string;
  try {
    accessToken = await decryptToken(tokenEnc);
  } catch (_e) {
    return c.json(
      { error: "Failed to decrypt OAuth token — token may be corrupted or the encryption key is unavailable" },
      500,
    );
  }

  const resp = await fetch(
    `https://api.github.com/user/installations/${installationId}/repositories?per_page=100`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "oxagen-ingestion/1.0",
      },
    },
  );

  if (!resp.ok) {
    return c.json(
      { error: `GitHub API returned ${resp.status} when listing repositories` },
      502,
    );
  }

  const data = (await resp.json()) as GitHubRepositoriesResponse;

  return c.json({
    repositories: data.repositories.map((r) => ({
      id: r.id,
      name: r.name,
      fullName: r.full_name,
      private: r.private,
      defaultBranch: r.default_branch,
      language: r.language,
      description: r.description,
    })),
    totalCount: data.total_count,
  });
});

// ── Public OAuth callback route ───────────────────────────────────────────────

/**
 * Public OAuth callback — NOT mounted in the workspace-scoped group.
 * The HMAC-verified state param is the security boundary.
 *
 * Mounted separately at app level: GET /oauth/github/callback
 *
 * Flow:
 *   1. Decode + verify the state HMAC (rejects tampered/expired state).
 *   2. Exchange the code for an access token via GitHub.
 *   3. Encrypt + store the tokens in ingestion.oauth_accounts.
 *   4. Link the oauth_account to the source_connection row.
 *   5. Redirect user back to the app's knowledge/sources page.
 */
export const githubOauthCallbackRoute = new Hono<AppEnv>();

githubOauthCallbackRoute.get("/callback", async (c) => {
  const code = c.req.query("code");
  const rawState = c.req.query("state");

  if (!code || !rawState) {
    return c.json({ error: "Missing code or state parameter" }, 400);
  }

  const env = requireEnv([
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_CLIENT_SECRET",
    "GITHUB_APP_INSTALL_STATE_SECRET",
    "NEXT_PUBLIC_APP_URL",
  ] as const);

  const clientId = env.GITHUB_APP_CLIENT_ID;
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET;
  const stateSecret = env.GITHUB_APP_INSTALL_STATE_SECRET;
  const appBaseUrl = env.NEXT_PUBLIC_APP_URL;

  if (!clientId || !clientSecret || !stateSecret) {
    return c.json(
      {
        error:
          "GitHub App is not configured — GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET / GITHUB_APP_INSTALL_STATE_SECRET missing",
      },
      503,
    );
  }

  // State format: "{base64url_json}.{hmac_hex}"
  const dotIdx = rawState.lastIndexOf(".");
  if (dotIdx === -1) {
    return c.json({ error: "Invalid state format" }, 400);
  }

  const encodedState = rawState.slice(0, dotIdx);
  const receivedHmac = rawState.slice(dotIdx + 1);

  let stateJson: string;
  try {
    stateJson = decodeState(encodedState);
  } catch {
    return c.json({ error: "Invalid state encoding" }, 400);
  }

  const expectedHmac = buildStateHmac(stateJson, stateSecret);
  // Constant-time comparison to prevent timing attacks
  if (receivedHmac.length !== expectedHmac.length) {
    return c.json({ error: "Invalid state signature" }, 400);
  }
  let hmacMismatch = 0;
  for (let i = 0; i < expectedHmac.length; i++) {
    hmacMismatch |= expectedHmac.charCodeAt(i) ^ receivedHmac.charCodeAt(i);
  }
  if (hmacMismatch !== 0) {
    return c.json({ error: "Invalid state signature" }, 400);
  }

  // Parse state payload
  let statePayload: {
    orgId: string;
    workspaceId: string;
    connectionId: string;
    expiresAt: number;
    nonce: string;
  };
  try {
    statePayload = JSON.parse(stateJson) as typeof statePayload;
  } catch {
    return c.json({ error: "Invalid state JSON" }, 400);
  }

  if (Date.now() > statePayload.expiresAt) {
    return c.json({ error: "OAuth state has expired — please start the OAuth flow again" }, 400);
  }

  const { orgId, workspaceId, connectionId: connectionPublicId } = statePayload;

  // Exchange code for tokens
  const tokenResp = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });

  if (!tokenResp.ok) {
    return c.json({ error: `GitHub token exchange failed with status ${tokenResp.status}` }, 502);
  }

  const tokenData = (await tokenResp.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (tokenData.error || !tokenData.access_token) {
    return c.json(
      { error: tokenData.error_description ?? tokenData.error ?? "Token exchange failed" },
      400,
    );
  }

  const { access_token, refresh_token, expires_in } = tokenData;

  // Encrypt both tokens using envelope encryption
  const { adapter, keyId } = createIngestionCryptoAdapter();

  const accessTokenBuf = await encrypt(access_token, keyId, { adapter });
  const accessTokenEnc = { keyId, ciphertext: accessTokenBuf.toString("base64") };

  let refreshTokenEnc: { keyId: string; ciphertext: string } | null = null;
  if (refresh_token) {
    const refreshBuf = await encrypt(refresh_token, keyId, { adapter });
    refreshTokenEnc = { keyId, ciphertext: refreshBuf.toString("base64") };
  }

  const expiresAt = expires_in ? new Date(Date.now() + expires_in * 1000) : null;

  // Fetch the authenticated GitHub user to get a stable provider_user_id.
  // Errors here are non-fatal — we fall back to a generated placeholder.
  let providerUserId = `github:${connectionPublicId}`;
  let providerUserEmail: string | null = null;
  let providerUserName: string | null = null;

  try {
    const userResp = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${access_token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "oxagen-ingestion/1.0",
      },
    });
    if (userResp.ok) {
      const userData = (await userResp.json()) as {
        id?: number;
        login?: string;
        email?: string | null;
        name?: string | null;
      };
      if (userData.id) providerUserId = String(userData.id);
      if (userData.email) providerUserEmail = userData.email;
      if (userData.name ?? userData.login)
        providerUserName = (userData.name ?? userData.login) ?? null;
    }
  } catch {
    // Non-fatal: proceed with placeholder providerUserId
  }

  // Resolve the internal connectionId (UUID) from the publicId.
  const connRows = await withSystemDb((tx) =>
    tx
      .select({
        id: schema.sourceConnections.id,
        orgId: schema.sourceConnections.orgId,
        workspaceId: schema.sourceConnections.workspaceId,
      })
      .from(schema.sourceConnections)
      .where(
        and(
          eq(schema.sourceConnections.publicId, connectionPublicId),
          eq(schema.sourceConnections.orgId, orgId),
          eq(schema.sourceConnections.workspaceId, workspaceId),
          isNull(schema.sourceConnections.deletedAt),
        ),
      )
      .limit(1),
  );

  const conn = connRows[0];
  if (!conn) {
    return c.json({ error: "Connection not found" }, 404);
  }

  // Upsert the oauth_accounts row.
  // The unique constraint is (orgId, provider, providerUserId) so re-authorising
  // the same GitHub account updates in place.
  const now = new Date();

  const oauthRows = await withSystemDb((tx) =>
    tx
      .insert(schema.oauthAccounts)
      .values({
        publicId: `oa_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        orgId,
        provider: "github",
        providerUserId,
        providerUserEmail,
        providerUserName,
        accessTokenEnc,
        refreshTokenEnc,
        expiresAt,
        tokenType: tokenData.token_type ?? "Bearer",
        scopes: tokenData.scope ? tokenData.scope.split(",").map((s) => s.trim()) : [],
        lastRefreshedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.oauthAccounts.orgId,
          schema.oauthAccounts.provider,
          schema.oauthAccounts.providerUserId,
        ],
        set: {
          accessTokenEnc,
          refreshTokenEnc,
          expiresAt,
          lastRefreshedAt: now,
          updatedAt: now,
          refreshFailureCount: 0,
        },
      })
      .returning({ id: schema.oauthAccounts.id }),
  );

  const oauthAccount = oauthRows[0];
  if (!oauthAccount) {
    return c.json({ error: "Failed to store OAuth account" }, 500);
  }

  // Link the oauth_account to the source_connection and reset to pending_setup
  // (the user still needs to pick repos).
  await withSystemDb((tx) =>
    tx
      .update(schema.sourceConnections)
      .set({
        oauthAccountId: oauthAccount.id,
        status: "pending_setup",
        updatedAt: now,
      })
      .where(eq(schema.sourceConnections.id, conn.id)),
  );

  // Determine org and workspace slugs from the state-encoded IDs.
  // We need slugs for the redirect URL; fetch them from Postgres.
  const orgSlugRows = await withSystemDb((tx) =>
    tx
      .select({ slug: schema.organizations.slug })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId))
      .limit(1),
  );
  const wsSlugRows = await withSystemDb((tx) =>
    tx
      .select({ slug: schema.workspaces.slug })
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.orgId, orgId)))
      .limit(1),
  );
  const orgSlug = orgSlugRows[0]?.slug ?? orgId;
  const wsSlug = wsSlugRows[0]?.slug ?? workspaceId;

  const redirectUrl =
    `${appBaseUrl}/${orgSlug}/${wsSlug}/knowledge/sources` +
    `?setup=github&connectionId=${encodeURIComponent(connectionPublicId)}`;

  return c.redirect(redirectUrl, 302);
});
