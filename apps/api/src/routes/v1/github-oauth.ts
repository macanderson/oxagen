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
import { schema, withSystemDb, withTenantDb } from "@oxagen/database";
// The install URL, its signed state and the verification of that state live in
// @oxagen/github: a capability handler needs the same install URL and cannot
// import from apps/api, and two copies of one HMAC scheme drift apart silently.
import {
  GITHUB_SETTINGS_INSTALLATIONS_URL,
  buildIdentityAuthUrl,
  buildInstallAuthUrl,
  buildManageInstallationUrl,
  parseReturnTo,
  verifyInstallState,
  type GithubInstallState,
  type GithubInstallStateError,
} from "@oxagen/github";
import { encrypt, decrypt, createIngestionCryptoAdapter } from "@oxagen/crypto";
import { and, desc, eq, isNull, notInArray } from "drizzle-orm";
import { runInTenantScope } from "@oxagen/tenancy";
import { assertOrgRole, type OrgRoleRequirement } from "@oxagen/iam/org-role";
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
    ? buildManageInstallationUrl(slug)
    : GITHUB_SETTINGS_INSTALLATIONS_URL;
}

/**
 * The callback's wording for each way a state fails to verify. The verifier
 * returns a reason rather than a message so this route keeps the exact strings
 * its clients and tests already read.
 */
const STATE_ERROR_MESSAGES: Record<GithubInstallStateError, string> = {
  invalid_format: "Invalid state format",
  invalid_encoding: "Invalid state encoding",
  invalid_signature: "Invalid state signature",
  invalid_json: "Invalid state JSON",
  expired: "OAuth state has expired — please start the OAuth flow again",
};

/**
 * The org roles that may start a SETTINGS-level GitHub connect.
 *
 * The same pair `attach_github_installation`, `get_main_repository` and
 * `bind_main_repository` admit (INV-29), and it has to be: a settings state
 * names the workspace and nothing else, so whoever holds one can complete the
 * identity leg as themselves and have the callback attach an installation THEY
 * reach onto the workspace's authoritative GitHub connection — overwriting the
 * one an Owner configured, and redirecting every repository operation this
 * workspace runs through.
 *
 * The capability gate alone did not stop that, because the HTTP route is a
 * second path to the same write and only one of them was gated. Membership is
 * what the mounted middleware establishes; role is what this asserts.
 */
const SETTINGS_CONNECT_ROLES: OrgRoleRequirement = {
  org: ["Owner", "Admin"],
};

/**
 * The roles that may start the LEGACY IN-WIZARD connect — a state that NAMES a
 * pre-created `source_connection`.
 *
 * The same pair `create_connection` and `delete_connection` admit
 * (`packages/oxagen/src/contracts/connection.create.ts`: org Owner/Admin, or
 * workspace Owner), so the route and the capability give one answer about who
 * may set a connection's credentials up rather than two.
 *
 * It needs a gate, and it never had one. The three earlier attempts at this
 * finding all spared this leg, each time on the reasoning that it "keeps the
 * authorization it already has" — and it had none. The mounted middleware
 * establishes workspace MEMBERSHIP and says nothing about role, and
 * `list_connections` admits a workspace Member, so a Member could read an
 * Owner-created connection's `publicId` out of the list, ask this route for a
 * state naming it, and authorize their own GitHub account into the callback's
 * `conn` branch — which:
 *
 *   - repoints `source_connections.oauth_account_id` at whichever GitHub
 *     account authorized the callback, unconditionally, so every later
 *     `/installations` and `/repositories` read for that connection resolves
 *     THEIR token;
 *   - overwrites `deliveryConfig.installationId` with any installation that
 *     account reaches (`installationClaimVerified` proves reachability BY THE
 *     AUTHORIZING USER, which is exactly what an attacker has), and that id is
 *     what `resolveWorkspaceGithubInstallation` hands to
 *     `list_installation_repositories` / `bind_main_repository`, which mint a
 *     token with the platform App's private key;
 *   - resets `status` to `pending_setup`, taking a live connection out of
 *     service.
 *
 * None of that is a read. Membership is not the bar for it.
 */
const CONNECTION_SETUP_ROLES: OrgRoleRequirement = {
  org: ["Owner", "Admin"],
  workspace: ["Owner"],
};

/**
 * Refuse to mint a signed install state for anyone who does not hold the roles
 * the write on the other side of it admits.
 *
 * Mint time is the enforceable point. The callback is a public OAuth redirect
 * with no session guarantee — that is exactly why it writes no `created_by_id`
 * — so a role cannot be re-checked there; the only moment a person is known is
 * when they ask for the URL. `assertOrgRole` throws `HandlerError
 * { code: "forbidden" }`, which the API's error middleware maps to 403.
 *
 * A caller with no `userId` is refused as `no_principal`. That is the intended
 * answer and not an oversight: every capability on the other side of this flow
 * requires a human. It does not refuse the CLI, which is a real caller of the
 * connection leg (`oxagen init` creates the connection and then asks for its
 * auth URL): `ApiKeyResult.userId` carries the key's creator for a CLI session
 * key, so the gate resolves that person's roles. A key that names no creator —
 * every other kind — is the one this turns away.
 *
 * Scoped by hand because this route makes no `invoke()` call, so nothing else
 * has opened a tenant scope for the role lookup to read in.
 */
async function assertMayMintInstallState(
  orgId: string,
  workspaceId: string,
  userId: string | null,
  required: OrgRoleRequirement,
): Promise<void> {
  await runInTenantScope({ orgId, workspaceId }, () =>
    assertOrgRole({ orgId, workspaceId, userId }, required),
  );
}

/**
 * Whether `connectionPublicId` names a live `source_connection` of THIS org and
 * workspace.
 *
 * A state is a signed, ten-minute bearer of the connection it names, so the
 * name is checked before it is signed rather than after it comes back. The
 * callback fences the same lookup and 404s an unresolvable id, which stops the
 * write; it does not stop the state existing, and a signed state for a
 * connection that does not resolve is a credential for nothing that still reads
 * as one. Refusing at mint keeps the two answers identical and moves the
 * failure to the moment a person is on the other end of it.
 *
 * Read inside the tenant scope so RLS bounds it to this org, with the org and
 * workspace written out as well — the same shape `resolveConnectionAccessToken`
 * and the callback both use.
 */
async function connectionExistsInScope(
  orgId: string,
  workspaceId: string,
  connectionPublicId: string,
): Promise<boolean> {
  const rows = await runInTenantScope({ orgId, workspaceId }, () =>
    withTenantDb((tx) =>
      tx
        .select({ id: schema.sourceConnections.id })
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
    ),
  );
  return rows.length > 0;
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

  // EVERY state this route mints is gated. Which roles, by what the state can
  // DO — never by the label the caller typed.
  //
  // `returnTo` is a free query parameter and the callback does not dispatch on
  // it: it picks the write path from the RESOLVED CONNECTION, and `returnTo`
  // only decides which page the redirect lands on at the end. So it appears in
  // neither predicate below. It appeared in two earlier ones and both were
  // walked around by asking for the other word.
  //
  //   - No `connectionId` → the callback reaches
  //     `attachVerifiedSettingsInstallation` / `resolveSettingsInstallationFromUser`,
  //     the settings write onto the workspace's authoritative GitHub
  //     connection → `SETTINGS_CONNECT_ROLES`.
  //   - A `connectionId` → the callback's `conn` branch, which repoints that
  //     connection's OAuth account, its installation id and its status →
  //     `CONNECTION_SETUP_ROLES`. See that constant for why membership was
  //     never the bar for it.
  //
  // A named connection is then resolved before it is signed into anything: a
  // state is a ten-minute bearer of the connection it names, so an id that does
  // not resolve in this org and workspace is refused here rather than carried
  // to GitHub and refused on the way back.
  const userId = c.get("userId") ?? null;
  if (connectionId === null) {
    await assertMayMintInstallState(
      orgId,
      workspaceId,
      userId,
      SETTINGS_CONNECT_ROLES,
    );
  } else {
    await assertMayMintInstallState(
      orgId,
      workspaceId,
      userId,
      CONNECTION_SETUP_ROLES,
    );
    if (!(await connectionExistsInScope(orgId, workspaceId, connectionId))) {
      return c.json({ error: "Connection not found" }, 404);
    }
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

  // Both URLs below carry a SETTINGS state, so this route is the same door as
  // /auth-url?returnTo=settings and takes the same gate. Refusing the whole
  // response rather than blanking the two URLs keeps one rule with one shape:
  // a settings-scoped signed state is an Owner/Admin thing to hold.
  await assertMayMintInstallState(
    orgId,
    workspaceId,
    c.get("userId") ?? null,
    SETTINGS_CONNECT_ROLES,
  );

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

/** The connector id of a workspace's GitHub source connection. */
const GITHUB_CONNECTOR_ID = "github";

/**
 * A GitHub installation id this route is willing to persist onto a connection:
 * a plain positive integer, which is exactly the shape `installationIdOf`
 * (packages/handlers/src/repository.github-connection.ts) accepts when the
 * repository capabilities read it back. Anything else would create a row every
 * reader silently skips — a connection that looks attached and is not — so the
 * settings leg logs and drops it instead of writing it.
 */
const INSTALLATION_ID_PATTERN = /^[1-9]\d{0,19}$/;

/**
 * What the callback settled about which installation this workspace acts
 * through. Five states, because the operator's next click differs in each and
 * a redirect that flattened them would put the wrong door in front of them.
 *
 *   attached    an installation was verified and written.
 *   refused     one was claimed and declined — say so; do not swallow it.
 *   unverified  one was claimed and there was nothing to check it against: the
 *               install leg returned no `code`, so no user token exists and
 *               `GET /user/installations` cannot be asked. Distinct from
 *               `refused` because the person did nothing wrong and the next
 *               click differs — the App IS installed now, so the identity leg
 *               finishes it in one step, whereas `refused` means installing
 *               again on the right account. Whether a `code` comes back is the
 *               App's "request user authorization (OAuth) during installation"
 *               setting, which is external configuration neither leg controls.
 *   choose      the authorizing user reaches several and the platform will not
 *               guess which one this workspace should act through.
 *   uninstalled the authorizing user reaches none: the App is installed on no
 *               account they administer, so the next click is to install it,
 *               not to authorize again.
 *   none        nothing was claimed and nothing could be looked up — there is
 *               no question to answer, so the honest acknowledgement is silence.
 */
type InstallAttachOutcome =
  | "none"
  | "attached"
  | "refused"
  | "unverified"
  | "choose"
  | "uninstalled";

/**
 * The query the settings redirect appends for each outcome — the whole contract
 * the Workspace settings dialog reads. The dialog treats anything it does not
 * recognise as no acknowledgement, which is what makes adding a state here
 * safe: a new word reaches an old dialog as silence, never as a claim.
 */
const GITHUB_ACK: Record<InstallAttachOutcome, string> = {
  attached: "&github=connected",
  refused: "&github=failed",
  unverified: "&github=authorize",
  choose: "&github=choose",
  uninstalled: "&github=install",
  none: "",
};

/**
 * Whether the user who authorized THIS callback can actually reach the
 * installation the redirect names.
 *
 * `installation_id` is a query parameter on a public endpoint. The state HMAC
 * proves which org+workspace started the flow; it proves nothing whatever about
 * the id, and the `code` is optional on this leg, so a person who legitimately
 * administers their own workspace can obtain a valid state for it (ten minutes)
 * and then call this callback directly with any numeric id they like — say, one
 * belonging to another tenant.
 *
 * That used not to matter, on either leg. The legacy wizard also took the id
 * from this parameter, but everything downstream of it called GitHub with the
 * **user OAuth token** (`GET /user/installations/:id/repositories`), and GitHub
 * itself refuses an installation that user cannot reach. The three repository
 * capabilities added in #2967 do not: `list_installation_repositories` and
 * `bind_main_repository` mint a token with the **platform App's private key**
 * (`getInstallationToken`), which checks no caller entitlement at all. GitHub's
 * own check is gone, so an unverified id is cross-tenant access to another
 * account's repositories — listed, and bindable.
 *
 * So the id is checked against `GET /user/installations`, the authenticated
 * user's own authoritative list, through the same `fetchAllInstallations` the
 * `/installations` and `/status` routes page with. Anything that is not a
 * positive match — a fetch that fails, a fetch that throws, a list the id is
 * absent from — is a refusal. Fail closed: the cost of a false refusal is the
 * operator clicking Connect again, and the cost of a false acceptance is
 * another tenant's source code.
 *
 * Both callback legs check through this; `installationClaimVerified` is the
 * shared gate that calls it.
 */
async function userCanReachInstallation(
  accessToken: string,
  installationId: string,
): Promise<boolean> {
  let fetched: FetchInstallationsResult;
  try {
    fetched = await fetchAllInstallations(accessToken);
  } catch (err) {
    // A network failure or the 10s per-page timeout. Never fatal to the
    // callback — the redirect below still lands the operator on the dialog.
    logger.warn(
      { err: String(err), installationId },
      "github install callback: could not verify the installation against /user/installations — not attached",
    );
    return false;
  }
  if (!fetched.ok) {
    logger.warn(
      { status: fetched.status, installationId },
      "github install callback: /user/installations answered non-OK while verifying the installation — not attached",
    );
    return false;
  }
  return fetched.installations.some(
    (inst) => String(inst.id) === installationId,
  );
}

/** Which of the callback's two legs a claim arrived on, for the log line. */
type InstallLeg = "settings" | "wizard";

/**
 * Whether an `installation_id` the redirect carried is one this callback is
 * willing to write onto a connection at all: syntactically usable by the
 * readers, and demonstrably reachable by the user who authorized this leg.
 *
 * The syntax guard runs first as a cheap pre-filter — it is what keeps a value
 * `installationIdOf` would silently skip out of the connection, so a row never
 * looks attached while every reader ignores it — and the reachability check
 * runs second, because it costs a GitHub round trip.
 *
 * BOTH legs go through this. The settings leg gained the check first; the
 * legacy wizard leg was left alone on the reasoning that everything it fed
 * called GitHub with the user token, which GitHub scopes to that user itself.
 * That reasoning expired with #2967: `resolveWorkspaceGithubInstallation`
 * (packages/handlers/src/repository.github-connection.ts) hands **any** github
 * connection row carrying an `installationId` — legacy wizard rows included —
 * to `list_installation_repositories` and `bind_main_repository`, and those
 * mint a token with the **platform App's private key**, which checks no caller
 * entitlement. So an id written by the wizard leg is an id the App acts
 * through, and the wizard leg's `installation_id` is the same unproven query
 * parameter on the same public endpoint as the settings leg's. One door or two
 * does not change what is behind it, so there is one check.
 */
type InstallClaimVerdict =
  /** Syntactically usable and demonstrably reachable by the authorizing user. */
  | "ok"
  /** Not a shape `installationIdOf` would ever read back. */
  | "malformed"
  /** No `code` on this leg, so no user token, so nothing to check it against. */
  | "unverifiable"
  /** Checked against the user's own list and absent from it. */
  | "unreachable";

async function installationClaimVerified(args: {
  orgId: string;
  workspaceId: string;
  installationId: string;
  userAccessToken: string | null;
  leg: InstallLeg;
}): Promise<InstallClaimVerdict> {
  const { orgId, workspaceId, installationId, userAccessToken, leg } = args;

  if (!INSTALLATION_ID_PATTERN.test(installationId)) {
    logger.warn(
      { orgId, workspaceId, installationId, leg },
      "github install callback: the install carried a malformed installation_id — not attached to the workspace connection",
    );
    return "malformed";
  }

  // No `code` on this leg → no user token → nothing can testify that this
  // person reaches this installation. An unverifiable claim is not a weaker
  // claim, it is no claim, and it is the exact shape the forgery takes.
  //
  // It is named apart from the other refusals only so the redirect can say
  // which next click finishes the job. Nothing is attached either way: the
  // install DID happen, and an honest person's next step is one click, but a
  // forged id arrives in exactly this shape too, so the answer is the same.
  if (!userAccessToken) {
    logger.warn(
      { orgId, workspaceId, installationId, leg },
      "github install callback: the install carried an installation_id but no OAuth code to verify it against — not attached",
    );
    return "unverifiable";
  }

  if (!(await userCanReachInstallation(userAccessToken, installationId))) {
    logger.warn(
      { orgId, workspaceId, installationId, leg },
      "github install callback: the authorizing user cannot reach this installation — not attached to the workspace connection",
    );
    return "unreachable";
  }

  return "ok";
}

/**
 * Attach a settings-level `installation_id` to the workspace, but only once the
 * authorizing user is shown to reach it. Answers the outcome the redirect needs.
 */
async function attachVerifiedSettingsInstallation(args: {
  orgId: string;
  workspaceId: string;
  installationId: string;
  userAccessToken: string | null;
  oauthAccountId: string | null;
  now: Date;
}): Promise<InstallAttachOutcome> {
  const verdict = await installationClaimVerified({
    orgId: args.orgId,
    workspaceId: args.workspaceId,
    installationId: args.installationId,
    userAccessToken: args.userAccessToken,
    leg: "settings",
  });
  // Nothing but "ok" attaches. The split exists so the dialog can name the
  // right next click: an install that came back without a `code` needs one
  // identity round trip, and everything else needs the App put on the account
  // that owns the repository.
  if (verdict === "unverifiable") return "unverified";
  if (verdict !== "ok") return "refused";

  await attachWorkspaceGithubInstallation({
    orgId: args.orgId,
    workspaceId: args.workspaceId,
    installationId: args.installationId,
    oauthAccountId: args.oauthAccountId,
    now: args.now,
  });
  return "attached";
}

/**
 * Settle a settings-level connect that arrived with NO `installation_id`.
 *
 * This is the identity leg, and it is now the leg the dialog opens. It has to
 * be: `installations/new` only round-trips a `code` and our signed state on the
 * FIRST install of the App on an account, so with it in the Connect button a
 * reconnect, and a second workspace connecting to an account that already has
 * the App, both dead-ended at the callback's no-state branch. The identity URL
 * (`login/oauth/authorize`) always returns a `code` and echoes the state —
 * and never returns an `installation_id`.
 *
 * So for a first-time user this callback used to end holding a live user token,
 * with `github.connected` still false and one button on the dialog that would
 * do the very same thing again. The token is not nothing, though: it is
 * authority to ask GitHub what this person reaches. `GET /user/installations`
 * answers, and each answer has its own next click.
 *
 *   one   attach it, and the person lands on the repository picker. It came
 *         from their own authenticated list, so it is verified by
 *         construction — and it still goes through
 *         `attachVerifiedSettingsInstallation`, which asks GitHub again. That
 *         second round trip is deliberate: one gate, taken by every path, is
 *         worth more than the 200ms, and a gate with an exemption is a gate
 *         with a way past it.
 *   many  say so and attach nothing. Which account a workspace acts through is
 *         a choice with consequences — the repository capabilities mint tokens
 *         with the platform App's key against whatever is attached — and
 *         guessing it is exactly the kind of quiet decision this product
 *         exists not to make. `list_github_installations` offers the choice on
 *         the dialog and `attach_github_installation` settles it.
 *   none  the App is installed nowhere they administer. Authorizing again
 *         would loop; the door they need is `installations/new`, which the
 *         dialog holds as `manageUrl`.
 *
 * A GitHub failure is `none`, not `refused`: nothing was claimed, so there is
 * nothing to decline, and the dialog re-reads its own state on arrival anyway.
 */
async function resolveSettingsInstallationFromUser(args: {
  orgId: string;
  workspaceId: string;
  userAccessToken: string;
  oauthAccountId: string | null;
  now: Date;
}): Promise<InstallAttachOutcome> {
  let fetched: FetchInstallationsResult;
  try {
    fetched = await fetchAllInstallations(args.userAccessToken);
  } catch (err) {
    logger.warn(
      { err: String(err), orgId: args.orgId, workspaceId: args.workspaceId },
      "github identity callback: could not list the authorizing user's installations — nothing attached",
    );
    return "none";
  }
  if (!fetched.ok) {
    logger.warn(
      {
        status: fetched.status,
        orgId: args.orgId,
        workspaceId: args.workspaceId,
      },
      "github identity callback: /user/installations answered non-OK — nothing attached",
    );
    return "none";
  }

  // Keep the platform catalog fresh from the user's authoritative view, exactly
  // as the /installations listing does. Best-effort: a registry hiccup must
  // never decide whether a connect completes.
  await Promise.allSettled(
    fetched.installations.map(registerInstallationFromApi),
  );

  if (fetched.installations.length === 0) return "uninstalled";
  if (fetched.installations.length > 1) return "choose";

  const only = fetched.installations[0];
  if (!only) return "none";

  return attachVerifiedSettingsInstallation({
    orgId: args.orgId,
    workspaceId: args.workspaceId,
    installationId: String(only.id),
    userAccessToken: args.userAccessToken,
    oauthAccountId: args.oauthAccountId,
    now: args.now,
  });
}

/**
 * Attach a settings-level GitHub App install to the workspace's GitHub source
 * connection, creating that connection when the workspace has none.
 *
 * Why this exists: `get_main_repository`, `bind_main_repository` and
 * `list_installation_repositories` all read the workspace's installation out of
 * `ingestion.source_connections` through one shared resolver
 * (`resolveWorkspaceGithubInstallation`). The platform catalog the callback
 * writes a few lines above — `ingestion.github_installations` — is a different,
 * org-less table that no capability reads. So without this, a settings-level
 * install (`connectionId: null`) landed the operator back on the dialog that
 * sent them to GitHub with `connected: false` still showing and nothing to
 * click: the install completed and the product could not see it.
 *
 * Scoped by BOTH ids from the HMAC-verified state, on the system seam because a
 * public OAuth redirect runs in no tenant scope. The select matches the
 * resolver's predicate exactly (org + workspace + connector + not soft-deleted)
 * so the row written is the row the readers read; picking by any narrower rule
 * would risk writing one row while they resolve another. Ordering is newest
 * first so a workspace carrying several legacy wizard connections gets a
 * deterministic answer — and `resolveWorkspaceGithubInstallation` now orders the
 * same way, because a predicate the two share and an ordering they do not is
 * still two rules: this could attach to the newest connection while the resolver
 * answered an older one, and the repository capabilities would go on acting
 * through a stale installation.
 *
 * The caller has already established that the authorizing user can reach this
 * installation (`attachVerifiedSettingsInstallation`). Nothing below re-checks
 * it, so this must not be called from anywhere that has not.
 */
async function attachWorkspaceGithubInstallation(args: {
  orgId: string;
  workspaceId: string;
  installationId: string;
  oauthAccountId: string | null;
  now: Date;
}): Promise<void> {
  const { orgId, workspaceId, installationId, oauthAccountId, now } = args;

  await withSystemDb(async (tx) => {
    const existing = await tx
      .select({
        id: schema.sourceConnections.id,
        deliveryConfig: schema.sourceConnections.deliveryConfig,
      })
      .from(schema.sourceConnections)
      .where(
        and(
          eq(schema.sourceConnections.orgId, orgId),
          eq(schema.sourceConnections.workspaceId, workspaceId),
          eq(schema.sourceConnections.connectorId, GITHUB_CONNECTOR_ID),
          isNull(schema.sourceConnections.deletedAt),
          // Same exclusion the resolver makes: `delete_connection` sets
          // `deleting` and leaves `deleted_at` to the purge job, so a row mid
          // delete is not a row to attach to. Skipping it here means a fresh
          // install after a delete inserts a fresh connection rather than
          // reviving the dying one — and, because this predicate and the
          // resolver's are the same, the row written stays the row read.
          notInArray(schema.sourceConnections.status, ["deleting", "deleted"]),
        ),
      )
      .orderBy(desc(schema.sourceConnections.createdAt))
      .limit(1);

    const row = existing[0];
    if (row) {
      // Merge, never replace: a connection the legacy wizard already configured
      // carries operational keys (owner/repo/defaultBranch, syncDepthDays) the
      // resync path reads. Status is left alone on purpose — a workspace that
      // has already bound a repository is `connected`, and re-installing the App
      // is not a reason to demote it.
      await tx
        .update(schema.sourceConnections)
        .set({
          deliveryConfig: {
            ...((row.deliveryConfig as Record<string, unknown> | null) ?? {}),
            installationId,
          },
          ...(oauthAccountId ? { oauthAccountId } : {}),
          updatedAt: now,
        })
        .where(eq(schema.sourceConnections.id, row.id));
      return;
    }

    await tx.insert(schema.sourceConnections).values({
      orgId,
      workspaceId,
      connectorId: GITHUB_CONNECTOR_ID,
      displayName: "GitHub",
      // The pair `connection.create` would record for a github connection: the
      // install leg runs the App's authorization-code grant ("Request user
      // authorization (OAuth) during installation"), and the connector declares
      // webhook delivery (packages/ingestion/src/connectors/github).
      authScheme: "oauth2_authorization_code",
      deliveryMethod: "webhook",
      deliveryConfig: { installationId },
      // `pending_setup`, not `connected`. The installation exists but nothing is
      // bound through it yet, and `status = 'connected'` is precisely what the
      // ingestion poll scheduler claims
      // (`source_connections_poll_due_partial_idx`), so marking it connected
      // here would enrol a workspace with no record-type mappings into the sync
      // loop. `bind_main_repository` promotes it to `connected` when it binds a
      // repository, and all three repository reads match on the installation id
      // rather than the status — so `pending_setup` blocks nothing the dialog
      // needs while keeping an unbound install out of the poller.
      status: "pending_setup",
      ...(oauthAccountId ? { oauthAccountId } : {}),
      createdAt: now,
      updatedAt: now,
      // No `created_by_id`. This is the public OAuth redirect: its security
      // boundary is the state HMAC, not an HTTP session, so there is no acting
      // user in context. The column is nullable (ADR-077) and a fabricated id
      // would be worse than an honest null — the install is evidenced by the
      // signed state and the `github_installations` catalog row.
    });
  });
}

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
 *   4. Attach the installation to the workspace's GitHub source connection —
 *      the legacy wizard's own connection, or, for a settings-level connect,
 *      the workspace's one GitHub connection, created here if it has none.
 *   5. Redirect the user back to the surface the connect started from: the
 *      Workspace settings dialog, or the legacy knowledge/sources wizard.
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

  // Signature, shape and expiry, verified in @oxagen/github against the same
  // scheme that minted the state. `connectionId` is null for a settings-level
  // connect (1 workspace = 1 app install, no source_connection yet); `returnTo`
  // may be absent on states minted before that field existed → "sources".
  const verified = verifyInstallState(rawState, stateSecret);
  if (!verified.ok) {
    return c.json({ error: STATE_ERROR_MESSAGES[verified.error] }, 400);
  }
  const statePayload: GithubInstallState = verified.state;

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
      // Refused, never downgraded. A state that NAMED a connection and whose
      // connection does not resolve in its own org+workspace is not the same
      // thing as a state that named none: letting it through would land on the
      // `else` branches below — the settings write onto the workspace's
      // authoritative GitHub connection — which is a different, more powerful
      // write than the one the state asked for. So the leg stops here.
      return c.json({ error: "Connection not found" }, 404);
    }
  }

  // Exchange the OAuth `code` for a user access token WHEN present. With "Request
  // user authorization (OAuth) during installation" enabled on the App, the
  // install redirect includes a `code`; if it is somehow absent we still record
  // the installation and let the user re-authorize from the wizard rather than
  // failing the whole connect.
  let oauthAccountId: string | null = null;
  // Kept beyond the exchange block: the settings-level attach below must prove
  // the person who authorized this callback can actually reach the
  // `installation_id` the redirect names, and GitHub's own
  // `/user/installations` is the only thing that can say so. See
  // `userCanReachInstallation`.
  let userAccessToken: string | null = null;
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
    userAccessToken = access_token;

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

  // Attach the install to the workspace, by whichever of the two routes it came
  // in on.
  //
  // Legacy in-wizard flow (`conn` resolved from the state's connectionId): link
  // the oauth_account (when obtained) and record the GitHub App installation id
  // onto that connection, resetting to pending_setup (the user still picks
  // repos). installationId is merged into deliveryConfig so the wizard can
  // pre-select the just-installed org, without clobbering existing config keys —
  // and only once the authorizing user is shown to reach it, because the
  // repository capabilities read this connection too.
  //
  // Settings-level connect (no connectionId — 1 workspace = 1 app install):
  // there is no connection yet and one is still required, because the three
  // repository capabilities behind the Workspace settings dialog read the
  // workspace's installation out of `ingestion.source_connections`. The org's
  // OAuth token stored above is NOT all that surface needs — that was true of
  // the deprecated settings page, which read the org token through
  // /connections/github/status, and false since #2967. See
  // attachWorkspaceGithubInstallation for the whole argument.
  let attachOutcome: InstallAttachOutcome = "none";
  if (conn) {
    // The id goes through exactly the check the settings leg makes — see
    // `installationClaimVerified` for why this leg is no longer exempt.
    //
    // What a refusal costs is deliberately bounded to the id. The other two
    // things this update writes are not claims made by the redirect's query
    // string: `oauthAccountId` names a token GitHub itself minted a few lines
    // above in exchange for a `code` GitHub issued, and the `pending_setup`
    // reset follows from the state HMAC, which proves which org, workspace and
    // connection started this flow. Only `installation_id` is unproven. So a
    // refusal drops the unproven fact and keeps the proven ones: the operator
    // returns to the wizard holding a live token, picks an installation from
    // `/user/installations` — where GitHub answers for reachability — and the
    // connect completes. Refusing the whole update instead would strip a
    // legitimately exchanged token from the connection and dead-end an honest
    // user at "OAuth token not found for connection", which punishes the wrong
    // party for a parameter the attacker, not they, controls.
    let verifiedInstallationId: string | null = null;
    if (installationId != null) {
      const verdict = await installationClaimVerified({
        orgId,
        workspaceId,
        installationId,
        userAccessToken,
        leg: "wizard",
      });
      verifiedInstallationId = verdict === "ok" ? installationId : null;
    }

    const mergedDeliveryConfig =
      verifiedInstallationId != null
        ? {
            ...((conn.deliveryConfig as Record<string, unknown> | null) ?? {}),
            installationId: verifiedInstallationId,
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
    attachOutcome = mergedDeliveryConfig
      ? "attached"
      : installationId != null
        ? "refused"
        : "none";
  } else if (installationId != null) {
    attachOutcome = await attachVerifiedSettingsInstallation({
      orgId,
      workspaceId,
      installationId,
      userAccessToken,
      oauthAccountId,
      now,
    });
  } else if (userAccessToken) {
    // The identity leg: a code came back and an installation id never does.
    // See resolveSettingsInstallationFromUser — this is where a first-time
    // connect from an account that already carries the App stops dead-ending.
    attachOutcome = await resolveSettingsInstallationFromUser({
      orgId,
      workspaceId,
      userAccessToken,
      oauthAccountId,
      now,
    });
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
  //
  // The settings target is the workspace landing route with the params that
  // open the Workspace settings dialog on its Repository section. It used to be
  // `/{org}/{ws}/settings/github?github_connected=1`, a route apps/app does not
  // have: legacy-routes.ts 308s it to `/{org}/{ws}` and a 308 drops the query
  // string, so a completed App install landed the operator on Fleet with no
  // acknowledgement and nothing to do — the one moment the product had to say
  // "now bind a repository" was spent on a silent redirect.
  //
  // The acknowledgement is the ATTACH's, not the redirect's. `github=connected`
  // used to be unconditional, so a leg that attached nothing — no
  // `installation_id` at all, or one the verification above refused — still told
  // the dialog the App was attached, and the dialog's very next read answered
  // `connected: false` and rendered the install panel. Announcing a connection
  // the product cannot see is the exact dishonesty this work exists to remove,
  // so each outcome gets its own word: `connected` only on a real attach,
  // `failed` when a claim was made and declined, `authorize` when one was made
  // and there was nothing to check it against (the install leg without a
  // `code`: the App is on the account now, and one identity round trip
  // finishes the job — a different next click from `failed`, which means
  // install it on the right account), and nothing at all when there was no
  // claim to make (the identity-only leg), because silence is the honest
  // answer to a question nobody asked.
  const redirectUrl =
    returnTo === "settings"
      ? `${appBaseUrl}/${orgSlug}/${wsSlug}/repositories?settings=repository${GITHUB_ACK[attachOutcome]}`
      : `${appBaseUrl}/${orgSlug}/${wsSlug}/knowledge/sources?setup=github` +
        (connectionPublicId
          ? `&connectionId=${encodeURIComponent(connectionPublicId)}`
          : "");

  return c.redirect(redirectUrl, 302);
});
