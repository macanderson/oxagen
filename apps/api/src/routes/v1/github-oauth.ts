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
import { and, desc, eq, isNull } from "drizzle-orm";
import { runInTenantScope } from "@oxagen/tenancy";
import type { AppEnv } from "../../app";
import { requireEnv } from "@oxagen/config/env";
import { upsertGithubInstallation } from "./github-installations";
import { logger } from "../../middleware/logger";

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
async function decryptToken(enc: {
  keyId: string;
  ciphertext: string;
}): Promise<string> {
  const { adapter } = createIngestionCryptoAdapter();
  const plain = await decrypt(
    Buffer.from(enc.ciphertext, "base64"),
    enc.keyId,
    { adapter },
  );
  return plain.toString("utf8");
}

type ConnectionTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; status: 404 | 500; error: string };

type EncryptedToken = { keyId: string; ciphertext: string };

/**
 * The org's most-recently-refreshed GitHub OAuth account, selected within an
 * existing tenant-scoped transaction. `oauth_accounts` is keyed by org (one row
 * per GitHub user per org), so this is the org's reusable user token — the same
 * trust boundary the OAuth callback writes to. Shared by both the connection-
 * scoped and workspace-scoped resolvers so there is exactly one definition of
 * "the org's GitHub token".
 */
async function selectOrgGithubOauthAccount(
  tx: Parameters<Parameters<typeof withTenantDb>[0]>[0],
  orgId: string,
): Promise<{ id: string; accessTokenEnc: unknown } | null> {
  const rows = await tx
    .select({
      id: schema.oauthAccounts.id,
      accessTokenEnc: schema.oauthAccounts.accessTokenEnc,
    })
    .from(schema.oauthAccounts)
    .where(
      and(
        eq(schema.oauthAccounts.orgId, orgId),
        eq(schema.oauthAccounts.provider, "github"),
      ),
    )
    .orderBy(desc(schema.oauthAccounts.updatedAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Decrypt an `accessTokenEnc` envelope into a `ConnectionTokenResult`, mapping a
 * missing envelope to 404 and a decrypt failure to 500. Centralises the
 * decode/error mapping both resolvers share.
 */
async function decryptAccessTokenResult(
  accessTokenEnc: unknown,
): Promise<ConnectionTokenResult> {
  const enc = accessTokenEnc as EncryptedToken | null;
  if (!enc) {
    return { ok: false, status: 404, error: "OAuth token not found" };
  }
  try {
    const accessToken = await decryptToken(enc);
    return { ok: true, accessToken };
  } catch {
    return {
      ok: false,
      status: 500,
      error:
        "Failed to decrypt OAuth token — token may be corrupted or the encryption key is unavailable",
    };
  }
}

/**
 * Resolve and decrypt the GitHub user OAuth token at the WORKSPACE level — i.e.
 * without a pre-created source_connection.
 *
 * This backs the settings-level "connect GitHub" surface and the sources
 * repo-picker once the App is already installed: both list installations/repos
 * for the workspace before any per-repo connection exists. The token is the
 * org's GitHub OAuth account (`oauth_accounts`), so this returns 404 when the
 * workspace's org has never connected GitHub. Runs inside the tenant scope so
 * RLS bounds the lookup to this org.
 */
async function resolveWorkspaceGithubToken(
  orgId: string,
  workspaceId: string,
): Promise<ConnectionTokenResult> {
  const account = await runInTenantScope({ orgId, workspaceId }, () =>
    withTenantDb((tx) => selectOrgGithubOauthAccount(tx, orgId)),
  );
  if (!account?.accessTokenEnc) {
    return {
      ok: false,
      status: 404,
      error: "GitHub is not connected for this workspace",
    };
  }
  return decryptAccessTokenResult(account.accessTokenEnc);
}

/**
 * Resolve and decrypt the GitHub user OAuth token used to call the GitHub REST
 * API for a connection (listing installations / repositories).
 *
 * A connection is normally linked to its `oauth_accounts` row by the OAuth
 * callback. But when the App is ALREADY installed, GitHub completes the connect
 * through the stateless **Setup URL** "update" leg, which never hits our OAuth
 * callback — so the freshly-created connection has a null `oauthAccountId` and
 * the old INNER JOIN returned 404, dead-ending the wizard at "list installations".
 *
 * The org already authorized GitHub on a prior connect, so its stored token is
 * reusable. When the connection isn't linked yet we fall back to the org's
 * most-recently-refreshed GitHub `oauth_accounts` row (same org → same trust
 * boundary the callback uses, which also keys oauth accounts by org) and **link
 * it onto the connection** so the activation path and subsequent calls resolve it
 * directly. Everything runs inside the tenant scope, so RLS still bounds the
 * lookup to this org.
 */
async function resolveConnectionAccessToken(
  orgId: string,
  workspaceId: string,
  connectionPublicId: string,
): Promise<ConnectionTokenResult> {
  const lookup = await runInTenantScope({ orgId, workspaceId }, () =>
    withTenantDb(async (tx) => {
      const connRows = await tx
        .select({
          id: schema.sourceConnections.id,
          oauthAccountId: schema.sourceConnections.oauthAccountId,
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
        .limit(1);

      const conn = connRows[0];
      if (!conn) return { kind: "no-connection" as const };

      // Already linked → use that account's token directly.
      if (conn.oauthAccountId) {
        const oaRows = await tx
          .select({ accessTokenEnc: schema.oauthAccounts.accessTokenEnc })
          .from(schema.oauthAccounts)
          .where(eq(schema.oauthAccounts.id, conn.oauthAccountId))
          .limit(1);
        const oa = oaRows[0];
        if (!oa?.accessTokenEnc) return { kind: "no-token" as const };
        return { kind: "ok" as const, accessTokenEnc: oa.accessTokenEnc };
      }

      // Not linked (Setup-URL "update" leg) → fall back to the org's GitHub
      // OAuth account and link it onto the connection for future calls.
      const fb = await selectOrgGithubOauthAccount(tx, orgId);
      if (!fb?.accessTokenEnc) return { kind: "no-token" as const };

      await tx
        .update(schema.sourceConnections)
        .set({ oauthAccountId: fb.id, updatedAt: new Date() })
        .where(eq(schema.sourceConnections.id, conn.id));

      return { kind: "ok" as const, accessTokenEnc: fb.accessTokenEnc };
    }),
  );

  if (lookup.kind === "no-connection") {
    return {
      ok: false,
      status: 404,
      error: "Connection not found or OAuth token missing",
    };
  }
  if (lookup.kind === "no-token") {
    return {
      ok: false,
      status: 404,
      error: "OAuth token not found for connection",
    };
  }

  return decryptAccessTokenResult(lookup.accessTokenEnc);
}

/**
 * Resolve the GitHub user OAuth token for a list/repos request, accepting an
 * OPTIONAL connectionId. With a connectionId we use the connection-scoped
 * resolver (which also self-heals the connection→oauth_account link); without
 * one — the settings connect and the post-install sources picker — we resolve
 * the workspace's org-level GitHub token directly.
 */
function resolveGithubListToken(
  orgId: string,
  workspaceId: string,
  connectionPublicId: string | undefined,
): Promise<ConnectionTokenResult> {
  return connectionPublicId
    ? resolveConnectionAccessToken(orgId, workspaceId, connectionPublicId)
    : resolveWorkspaceGithubToken(orgId, workspaceId);
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
  const slug =
    configuredSlug?.trim() || installations.find((i) => i.app_slug)?.app_slug;
  return slug
    ? `https://github.com/apps/${slug}/installations/new`
    : "https://github.com/settings/installations";
}

/**
 * Where the OAuth callback should land the user after a connect. The install
 * now lives in Workspace Settings → GitHub (1 workspace = 1 app install), while
 * the legacy in-wizard connect still returns to the sources picker. The value is
 * carried in the signed state so the (single, global) callback can route back to
 * the surface the connect started from.
 */
type GithubConnectReturnTo = "settings" | "sources";

function parseReturnTo(raw: string | undefined): GithubConnectReturnTo {
  return raw === "settings" ? "settings" : "sources";
}

/** Signed-state payload round-tripped through GitHub's `state` query param. */
interface GithubInstallState {
  orgId: string;
  workspaceId: string;
  /** publicId of a pre-created source_connection, or null for a settings-level connect. */
  connectionId: string | null;
  returnTo: GithubConnectReturnTo;
  expiresAt: number;
  nonce: string;
}

/**
 * Build the signed GitHub App installation URL (`installations/new?state=…`).
 *
 * Drive the user through the App *installation* flow, NOT the bare
 * `login/oauth/authorize` flow: the connector needs the App installed on the
 * target org to read repos, and `installations/new` both installs the App and —
 * with "Request user authorization (OAuth) during installation" enabled — returns
 * an OAuth `code` to the configured callback. GitHub round-trips the `state` we
 * pass here back to the callback, so it can verify the HMAC and attribute the
 * install to the right org/workspace (and connection, when present). The
 * post-install redirect target is the App's configured Callback URL, so no
 * redirect_uri is passed.
 */
function buildInstallAuthUrl(
  appSlug: string,
  stateSecret: string,
  payload: {
    orgId: string;
    workspaceId: string;
    connectionId: string | null;
    returnTo: GithubConnectReturnTo;
  },
): string {
  const stateJson = JSON.stringify({
    orgId: payload.orgId,
    workspaceId: payload.workspaceId,
    connectionId: payload.connectionId,
    returnTo: payload.returnTo,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
    nonce: crypto.randomUUID(),
  } satisfies GithubInstallState);

  const hmac = buildStateHmac(stateJson, stateSecret);
  const encodedState = encodeState(stateJson);

  return (
    `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new` +
    `?state=${encodeURIComponent(`${encodedState}.${hmac}`)}`
  );
}

/**
 * Build the signed GitHub user-authorization URL (`login/oauth/authorize`) — the
 * IDENTITY leg, and the PRIMARY "Connect GitHub" entry point.
 *
 * Why this and not `installations/new`: the install URL only round-trips an OAuth
 * `code` on the FIRST install of the App on an account. Once the App is already
 * installed on an org, GitHub degrades to its stateless Setup-URL "update"
 * redirect, which carries NO `code` and NO signed `state` — so a SECOND Oxagen
 * tenant (a different org/workspace) can never establish its own token and dead-
 * ends at "not connected". The bare user-authorization endpoint has no such
 * dependence: it ALWAYS returns a fresh `code` and echoes our signed `state`,
 * installed-or-not (and silently round-trips with no prompt if the user already
 * authorized). That single fresh `code` is exactly what the callback's
 * oauth_accounts upsert needs, so the second tenant becomes connected and can
 * then attach to the already-installed org via `/user/installations`.
 *
 * GitHub redirects to the App's configured Callback URL (our
 * `/oauth/github/callback`) — the same endpoint the install leg lands on — so no
 * `redirect_uri` is passed.
 */
function buildIdentityAuthUrl(
  clientId: string,
  stateSecret: string,
  payload: {
    orgId: string;
    workspaceId: string;
    connectionId: string | null;
    returnTo: GithubConnectReturnTo;
  },
): string {
  const stateJson = JSON.stringify({
    orgId: payload.orgId,
    workspaceId: payload.workspaceId,
    connectionId: payload.connectionId,
    returnTo: payload.returnTo,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
    nonce: crypto.randomUUID(),
  } satisfies GithubInstallState);

  const hmac = buildStateHmac(stateJson, stateSecret);
  const encodedState = encodeState(stateJson);

  return (
    `https://github.com/login/oauth/authorize` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&state=${encodeURIComponent(`${encodedState}.${hmac}`)}`
  );
}

// ── GET /connections/github/auth-url ─────────────────────────────────────────

/**
 * Generate a signed GitHub App installation URL.
 *
 * Query params:
 *   connectionId  — OPTIONAL publicId of a pre-created source_connection row.
 *                   Omitted for a settings-level connect (1 workspace = 1 install).
 *   returnTo      — OPTIONAL "settings" | "sources" (default "sources"); where the
 *                   callback lands the user after the install completes.
 *
 * Returns:
 *   { authUrl: string }
 */
githubOauthRoute.get("/auth-url", async (c) => {
  const env = requireEnv([
    "GITHUB_APP_SLUG",
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_INSTALL_STATE_SECRET",
  ] as const);

  const connectionId = c.req.query("connectionId") ?? null;
  const returnTo = parseReturnTo(c.req.query("returnTo"));
  // "install" (default) → installations/new: installs the App on a NEW org (and,
  // on a first install, round-trips our signed state to the callback). "identity"
  // (opt-in via ?mode=identity) → login/oauth/authorize: always returns code+state
  // EVEN WHEN the App is already installed on the target org, which is what
  // unblocks a second tenant. The app's primary Connect uses /status.identityUrl,
  // so /auth-url stays install-by-default for backward compatibility.
  const mode = c.req.query("mode") === "identity" ? "identity" : "install";

  const orgId = c.get("orgId");
  const workspaceId = c.get("workspaceId");
  if (!orgId || !workspaceId) {
    return c.json({ error: "Org/workspace scope required" }, 400);
  }

  const stateSecret = env.GITHUB_APP_INSTALL_STATE_SECRET;
  if (!stateSecret) {
    return c.json(
      {
        error:
          "GitHub App is not configured — GITHUB_APP_INSTALL_STATE_SECRET missing",
      },
      503,
    );
  }

  const statePayload = { orgId, workspaceId, connectionId, returnTo };

  if (mode === "install") {
    const appSlug = env.GITHUB_APP_SLUG;
    if (!appSlug) {
      return c.json(
        { error: "GitHub App is not configured — GITHUB_APP_SLUG missing" },
        503,
      );
    }
    return c.json({
      authUrl: buildInstallAuthUrl(appSlug, stateSecret, statePayload),
      mode,
    });
  }

  const clientId = env.GITHUB_APP_CLIENT_ID;
  if (!clientId) {
    return c.json(
      { error: "GitHub App is not configured — GITHUB_APP_CLIENT_ID missing" },
      503,
    );
  }
  return c.json({
    authUrl: buildIdentityAuthUrl(clientId, stateSecret, statePayload),
    mode,
  });
});

// ── GET /connections/github/installations ─────────────────────────────────────

interface GitHubInstallation {
  id: number;
  account: {
    login: string;
    type: string;
    avatar_url: string;
    /** GitHub account numeric id — recorded in the installations registry. */
    id?: number;
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

/** Outcome of paging GitHub's `/user/installations` with a user token. */
type FetchInstallationsResult =
  | { ok: true; installations: GitHubInstallation[] }
  | { ok: false; status: number };

const INSTALLATIONS_PER_PAGE = 100;
/**
 * Hard ceiling on pages fetched from `/user/installations`. 100 pages × 100 per
 * page is far beyond any real account, and it is what makes the loop below
 * provably terminate: the exit condition depends on GitHub's `total_count`,
 * which is upstream-controlled and need not agree with the rows actually
 * returned.
 */
const INSTALLATIONS_MAX_PAGES = 100;

/**
 * Page through every GitHub App installation the user token can see (GitHub
 * paginates at 100/page). Shared by `/installations` and `/status` so there is
 * one definition of "list the App installations this workspace can reach".
 *
 * The loop terminates on the FIRST of three conditions — the collected count
 * reaching `total_count`, a short/empty page, or the page ceiling. Trusting
 * `total_count` alone is not safe: a page that returns fewer rows than it
 * promises (GitHub filters suspended installations out of the rows but not out
 * of the count) would leave the count unreachable and spin this request against
 * the GitHub API until the platform request timeout kills it.
 */
async function fetchAllInstallations(
  accessToken: string,
): Promise<FetchInstallationsResult> {
  const allInstallations: GitHubInstallation[] = [];
  let totalCount = 0;

  for (let page = 1; page <= INSTALLATIONS_MAX_PAGES; page++) {
    const resp = await fetch(
      `https://api.github.com/user/installations?per_page=${INSTALLATIONS_PER_PAGE}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "oxagen-ingestion/1.0",
        },
        // Paged loop — without a timeout one stalled GitHub page hangs
        // the whole request, not just this page.
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!resp.ok) return { ok: false, status: resp.status };

    const data = (await resp.json()) as GitHubInstallationsResponse;
    totalCount = data.total_count;
    const rows = data.installations ?? [];
    allInstallations.push(...rows);
    // A short page is the last page: GitHub has no more rows to give, whatever
    // `total_count` claims.
    if (rows.length < INSTALLATIONS_PER_PAGE) break;
    if (allInstallations.length >= totalCount) break;
  }

  return { ok: true, installations: allInstallations };
}

/** Register a raw GitHub `/user/installations` entry into the platform registry. */
function registerInstallationFromApi(inst: GitHubInstallation): Promise<void> {
  return upsertGithubInstallation({
    installationId: String(inst.id),
    accountLogin: inst.account?.login ?? null,
    accountId: inst.account?.id != null ? String(inst.account.id) : null,
    accountType: inst.account?.type ?? null,
    appSlug: inst.app_slug ?? null,
    repositorySelection: inst.repository_selection ?? null,
  });
}

/** Project a raw GitHub installation into the client-facing wire shape. */
function mapInstallation(inst: GitHubInstallation) {
  return {
    id: inst.id,
    accountLogin: inst.account.login,
    accountType: inst.account.type,
    repositorySelection: inst.repository_selection,
    avatarUrl: inst.account.avatar_url,
    // Per-installation page for managing which repos this org grants access to.
    htmlUrl: inst.html_url ?? null,
  };
}

/**
 * List GitHub App installations accessible to the OAuth-authed user.
 *
 * Query params:
 *   connectionId — OPTIONAL publicId of the source_connection used to look up the
 *                  token. Omitted by the settings surface and the post-install
 *                  sources picker, which resolve the workspace's org-level token.
 *
 * Returns:
 *   { installations: [{ id, accountLogin, accountType, repositorySelection, avatarUrl }], manageUrl }
 */
githubOauthRoute.get("/installations", async (c) => {
  const connectionPublicId = c.req.query("connectionId") || undefined;

  const orgId = c.get("orgId");
  const workspaceId = c.get("workspaceId");
  if (!orgId || !workspaceId) {
    return c.json({ error: "Org/workspace scope required" }, 400);
  }

  // Resolve the OAuth token: connection-scoped when a connectionId is supplied
  // (also self-heals the connection→oauth_account link), else the workspace's
  // org-level GitHub token.
  const tokenResult = await resolveGithubListToken(
    orgId,
    workspaceId,
    connectionPublicId,
  );
  if (!tokenResult.ok) {
    return c.json({ error: tokenResult.error }, tokenResult.status);
  }

  const fetched = await fetchAllInstallations(tokenResult.accessToken);
  if (!fetched.ok) {
    return c.json(
      {
        error: `GitHub API returned ${fetched.status} when listing installations`,
      },
      502,
    );
  }

  // Refresh the platform installations registry from the user's authoritative
  // view (idempotent). Best-effort via allSettled — a registry write hiccup must
  // never break the listing the wizard depends on.
  await Promise.allSettled(
    fetched.installations.map(registerInstallationFromApi),
  );

  const { GITHUB_APP_SLUG } = requireEnv(["GITHUB_APP_SLUG"] as const);

  return c.json({
    // Top-level link to GitHub's install/configure page so the user can add the
    // App to another org (or remove one) and have it appear after a refresh.
    manageUrl: buildManageInstallationsUrl(
      GITHUB_APP_SLUG,
      fetched.installations,
    ),
    installations: fetched.installations.map(mapInstallation),
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
 *   connectionId — OPTIONAL publicId of the source_connection used to look up the
 *                  token. Omitted by the settings surface and the post-install
 *                  sources picker, which resolve the workspace's org-level token.
 *
 * Returns:
 *   { repositories: [...], totalCount: number }
 */
githubOauthRoute.get(
  "/installations/:installationId/repositories",
  async (c) => {
    const installationId = c.req.param("installationId");
    const connectionPublicId = c.req.query("connectionId") || undefined;

    const orgId = c.get("orgId");
    const workspaceId = c.get("workspaceId");
    if (!orgId || !workspaceId) {
      return c.json({ error: "Org/workspace scope required" }, 400);
    }

    // Same resilient token resolution as /installations.
    const tokenResult = await resolveGithubListToken(
      orgId,
      workspaceId,
      connectionPublicId,
    );
    if (!tokenResult.ok) {
      return c.json({ error: tokenResult.error }, tokenResult.status);
    }
    const accessToken = tokenResult.accessToken;

    const resp = await fetch(
      `https://api.github.com/user/installations/${installationId}/repositories?per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "oxagen-ingestion/1.0",
        },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!resp.ok) {
      return c.json(
        {
          error: `GitHub API returned ${resp.status} when listing repositories`,
        },
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
  },
);

// ── GET /connections/github/status ────────────────────────────────────────────

/**
 * Report the workspace's GitHub App connection status for the settings surface.
 *
 * "Connected" means the workspace's org has a usable GitHub OAuth token (the App
 * was installed/authorized once — 1 workspace = 1 app install). The same install
 * can back many orgs/workspaces, so this lists every installation the token can
 * reach; the settings UI surfaces them and the sources picker selects repos from
 * them. `installUrl` is always returned so the UI can offer "Connect" whether or
 * not GitHub is already linked.
 *
 * Returns:
 *   { connected, installations: [...], manageUrl, installUrl }
 */
githubOauthRoute.get("/status", async (c) => {
  const env = requireEnv([
    "GITHUB_APP_SLUG",
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_INSTALL_STATE_SECRET",
  ] as const);

  const orgId = c.get("orgId");
  const workspaceId = c.get("workspaceId");
  if (!orgId || !workspaceId) {
    return c.json({ error: "Org/workspace scope required" }, 400);
  }

  const appSlug = env.GITHUB_APP_SLUG;
  const clientId = env.GITHUB_APP_CLIENT_ID;
  const stateSecret = env.GITHUB_APP_INSTALL_STATE_SECRET;
  if (!appSlug || !stateSecret) {
    return c.json(
      {
        error:
          "GitHub App is not configured — GITHUB_APP_SLUG / GITHUB_APP_INSTALL_STATE_SECRET missing",
      },
      503,
    );
  }

  const stateArgs = {
    orgId,
    workspaceId,
    connectionId: null,
    returnTo: "settings" as const,
  };

  // installUrl → installations/new (install the App on a NEW org / change repos).
  const installUrl = buildInstallAuthUrl(appSlug, stateSecret, stateArgs);
  // identityUrl → login/oauth/authorize: the PRIMARY "Connect GitHub" entry. It
  // always returns code+state, so it works even when the App is already
  // installed on the org the user wants (the second-tenant case). Falls back to
  // installUrl only if the client id is unset. The settings UI should prefer it.
  const identityUrl = clientId
    ? buildIdentityAuthUrl(clientId, stateSecret, stateArgs)
    : installUrl;

  // Not-connected shape, reused for "never connected" and "token revoked" so the
  // UI shows the same "Connect" affordance in both cases.
  const notConnected = {
    connected: false as const,
    installations: [] as ReturnType<typeof mapInstallation>[],
    manageUrl: buildManageInstallationsUrl(appSlug, []),
    installUrl,
    identityUrl,
  };

  const tokenResult = await resolveWorkspaceGithubToken(orgId, workspaceId);
  if (!tokenResult.ok) {
    // 404 = org never connected GitHub; 500 = token undecryptable. Either way the
    // user must (re)connect, so report not-connected rather than erroring.
    return c.json(notConnected);
  }

  const fetched = await fetchAllInstallations(tokenResult.accessToken);
  if (!fetched.ok) {
    // A revoked/expired user token surfaces as 401/403 → treat as not-connected so
    // the UI offers a reconnect. Other statuses are genuine upstream failures.
    if (fetched.status === 401 || fetched.status === 403) {
      return c.json(notConnected);
    }
    return c.json(
      {
        error: `GitHub API returned ${fetched.status} when listing installations`,
      },
      502,
    );
  }

  // Keep the registry fresh from the user's authoritative view (best-effort).
  await Promise.allSettled(
    fetched.installations.map(registerInstallationFromApi),
  );

  return c.json({
    connected: true,
    installations: fetched.installations.map(mapInstallation),
    manageUrl: buildManageInstallationsUrl(appSlug, fetched.installations),
    installUrl,
    identityUrl,
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
  // GitHub App installation legs also send these (the OAuth-only leg does not).
  const setupAction = c.req.query("setup_action");
  const installationId = c.req.query("installation_id");

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

  // A GitHub App can redirect here WITHOUT our signed state — e.g. a user who
  // installs the App directly from GitHub's app page, or an org owner who
  // approves a member's pending install request. Those carry installation_id +
  // setup_action but no `state`, so they cannot be attributed to a workspace
  // from the redirect alone (the App-level `installation` webhook is the system
  // of record for them). Send such users into the app rather than returning a
  // bare JSON 400.
  if (!rawState) {
    if (installationId || setupAction) {
      // Direct-from-GitHub install / owner-approval: no signed state → no tenant
      // context, but the installations registry is platform-scoped, so we still
      // record the installation id here (the App webhook + the first tenant to
      // attach enrich + bind it). A completed install means it is live → reactivate.
      if (installationId) {
        await upsertGithubInstallation({
          installationId,
          reactivate: true,
        }).catch((err) =>
          logger.warn(
            { err: String(err), installationId },
            "github_installations registry upsert failed (no-state install leg) — relying on App-webhook backstop",
          ),
        );
      }
      return c.redirect(`${appBaseUrl}/?github_installed=1`, 302);
    }
    return c.json({ error: "Missing state parameter" }, 400);
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

  // Parse state payload. `connectionId` is null for a settings-level connect
  // (1 workspace = 1 app install, no source_connection yet); `returnTo` may be
  // absent on states minted before this field existed → default to "sources".
  let statePayload: GithubInstallState;
  try {
    statePayload = JSON.parse(stateJson) as GithubInstallState;
  } catch {
    return c.json({ error: "Invalid state JSON" }, 400);
  }

  if (Date.now() > statePayload.expiresAt) {
    return c.json(
      { error: "OAuth state has expired — please start the OAuth flow again" },
      400,
    );
  }

  const { orgId, workspaceId, connectionId: connectionPublicId } = statePayload;
  const returnTo = parseReturnTo(statePayload.returnTo);
  const now = new Date();

  // Resolve the internal connection (UUID) from the publicId up front — needed
  // whether or not the install redirect carried an OAuth `code`. Pull the current
  // deliveryConfig too so we can merge the installation id without clobbering the
  // operational keys (owner/repo/defaultBranch) the resync path relies on.
  // A settings-level connect carries no connectionId: there is no source
  // connection to attach to, only the org's OAuth token to (re)store.
  let conn: { id: string; deliveryConfig: unknown } | null = null;
  if (connectionPublicId) {
    const connRows = await withSystemDb((tx) =>
      tx
        .select({
          id: schema.sourceConnections.id,
          deliveryConfig: schema.sourceConnections.deliveryConfig,
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
    conn = connRows[0] ?? null;
    if (!conn) {
      return c.json({ error: "Connection not found" }, 404);
    }
  }

  // Exchange the OAuth `code` for a user access token WHEN present. With "Request
  // user authorization (OAuth) during installation" enabled on the App, the
  // install redirect includes a `code`; if it is somehow absent we still record
  // the installation and let the user re-authorize from the wizard rather than
  // failing the whole connect.
  let oauthAccountId: string | null = null;
  if (code) {
    const tokenResp = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
        }),
      },
    );

    if (!tokenResp.ok) {
      return c.json(
        {
          error: `GitHub token exchange failed with status ${tokenResp.status}`,
        },
        502,
      );
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
        {
          error:
            tokenData.error_description ??
            tokenData.error ??
            "Token exchange failed",
        },
        400,
      );
    }

    const { access_token, refresh_token, expires_in } = tokenData;

    // Encrypt both tokens using envelope encryption
    const { adapter, keyId } = createIngestionCryptoAdapter();

    const accessTokenBuf = await encrypt(access_token, keyId, { adapter });
    const accessTokenEnc = {
      keyId,
      ciphertext: accessTokenBuf.toString("base64"),
    };

    let refreshTokenEnc: { keyId: string; ciphertext: string } | null = null;
    if (refresh_token) {
      const refreshBuf = await encrypt(refresh_token, keyId, { adapter });
      refreshTokenEnc = { keyId, ciphertext: refreshBuf.toString("base64") };
    }

    const expiresAt = expires_in
      ? new Date(Date.now() + expires_in * 1000)
      : null;

    // Fetch the authenticated GitHub user to get a stable provider_user_id.
    // Errors here are non-fatal — we fall back to a generated placeholder. The
    // placeholder keys off the connection when present, else the workspace (the
    // settings connect has no connection id).
    let providerUserId = `github:${connectionPublicId ?? workspaceId}`;
    let providerUserEmail: string | null = null;
    let providerUserName: string | null = null;

    try {
      const userResp = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${access_token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "oxagen-ingestion/1.0",
        },
        signal: AbortSignal.timeout(10_000),
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
          providerUserName = userData.name ?? userData.login ?? null;
      }
    } catch {
      // Non-fatal: proceed with placeholder providerUserId
    }

    // Upsert the oauth_accounts row.
    // The unique constraint is (orgId, provider, providerUserId) so re-authorising
    // the same GitHub account updates in place.
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
          scopes: tokenData.scope
            ? tokenData.scope.split(",").map((s) => s.trim())
            : [],
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
    oauthAccountId = oauthAccount.id;
  }

  // Register the installation in the platform catalog (idempotent). GitHub's
  // callback carries only the id (not account details) — the /installations
  // listing the UI calls next, and the App webhook, enrich it. A completed
  // install/approval means the installation is live, so reactivate.
  if (installationId) {
    await upsertGithubInstallation({ installationId, reactivate: true }).catch(
      (err) =>
        logger.warn(
          { err: String(err), installationId },
          "github_installations registry upsert failed (callback install leg) — relying on App-webhook backstop",
        ),
    );
  }

  // When the connect started from a source_connection (the legacy in-wizard
  // flow), link the oauth_account (when obtained) and record the GitHub App
  // installation id onto the connection, resetting to pending_setup (the user
  // still picks repos). installationId is merged into deliveryConfig so the
  // wizard can pre-select the just-installed org, without clobbering existing
  // config keys. The settings connect has no connection, so this is skipped —
  // the org's OAuth token (stored above) is all the settings surface needs.
  if (conn) {
    const mergedDeliveryConfig =
      installationId != null
        ? {
            ...((conn.deliveryConfig as Record<string, unknown> | null) ?? {}),
            installationId,
          }
        : undefined;

    await withSystemDb((tx) =>
      tx
        .update(schema.sourceConnections)
        .set({
          ...(oauthAccountId ? { oauthAccountId } : {}),
          ...(mergedDeliveryConfig
            ? { deliveryConfig: mergedDeliveryConfig }
            : {}),
          status: "pending_setup",
          updatedAt: now,
        })
        .where(eq(schema.sourceConnections.id, conn.id)),
    );
  }

  // Determine org and workspace slugs from the state-encoded IDs.
  // We need slugs for the redirect URL; fetch them from Postgres. The two
  // lookups are independent, so run them concurrently rather than serially.
  const [orgSlugRows, wsSlugRows] = await Promise.all([
    withSystemDb((tx) =>
      tx
        .select({ slug: schema.organizations.slug })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, orgId))
        .limit(1),
    ),
    withSystemDb((tx) =>
      tx
        .select({ slug: schema.workspaces.slug })
        .from(schema.workspaces)
        .where(
          and(
            eq(schema.workspaces.id, workspaceId),
            eq(schema.workspaces.orgId, orgId),
          ),
        )
        .limit(1),
    ),
  ]);
  const orgSlug = orgSlugRows[0]?.slug ?? orgId;
  const wsSlug = wsSlugRows[0]?.slug ?? workspaceId;

  // Route back to the surface the connect started from. Settings is the new home
  // for the install (1 workspace = 1 app install); the legacy wizard resumes at
  // the sources repo-picker, carrying the connectionId so it lands on Step 2.
  const redirectUrl =
    returnTo === "settings"
      ? `${appBaseUrl}/${orgSlug}/${wsSlug}/settings/github?github_connected=1`
      : `${appBaseUrl}/${orgSlug}/${wsSlug}/knowledge/sources?setup=github` +
        (connectionPublicId
          ? `&connectionId=${encodeURIComponent(connectionPublicId)}`
          : "");

  return c.redirect(redirectUrl, 302);
});
