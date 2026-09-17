// repository.github-user-installations.ts — the GitHub App installations a
// workspace's own stored GitHub authorization can reach, and the one place in
// this package that asks GitHub the question.
//
// Why it exists. The install leg (`installations/new`) hands the OAuth callback
// an `installation_id`; the identity leg (`login/oauth/authorize`) never does,
// and the identity leg is the one the Workspace settings dialog opens, because
// it is the only one that round-trips a `code` when the App is already
// installed on the target account. So a person can return from GitHub holding a
// live user token with nothing attached, and the only thing that can say WHICH
// installation they meant is GitHub's own `GET /user/installations` for that
// token.
//
// Three callers, one implementation. `list_github_installations` offers the
// choice, `attach_github_installation` re-asks the same list before it writes,
// and `assertGithubInstallationAccessible` (./lib/github-installation-access)
// gates the connector paths that take an installation id through
// `connectionConfig`. The re-ask is the point: an installation id names an
// account's source code, and the token the repository capabilities mint through
// it carries no caller entitlement at all — GitHub asks who the App is, not who
// asked. So nothing here takes an id on trust, and nothing here offers a way to.
import { schema, withTenantDb } from "@oxagen/database";
import { decrypt, resolveIngestionCryptoAdapterForKeyId } from "@oxagen/crypto";
import { and, desc, eq } from "drizzle-orm";
import { logger } from "./logger";

/** The org+workspace an installation question is asked about. */
export interface GithubUserInstallationScope {
  orgId: string;
  workspaceId: string;
}

/** One row of `GET /user/installations`, as this package consumes it. */
export interface UserGithubInstallation {
  /** GitHub's numeric installation id as text. */
  installationId: string;
  /**
   * The account the App is installed on. Nullable because a remote response is
   * optional until proven, and because a reachability check must count a row it
   * cannot name — dropping it here would turn an unnameable installation into
   * an unreachable one, which is a security gate answering a question about
   * presentation. The picker is what filters these out; it has to name what it
   * offers.
   */
  accountLogin: string | null;
  accountType: string | null;
  avatarUrl: string | null;
  repositorySelection: string | null;
}

/**
 * Why a workspace has no GitHub user token to ask with. Two reasons, not one,
 * because they have different next clicks: nobody has connected GitHub for this
 * org, or someone did and the envelope cannot be opened by this runtime.
 */
export type WorkspaceGithubTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: "no_account" | "unreadable" };

/**
 * What the workspace's stored authorization can see, or `null` when there is no
 * usable token to ask with.
 *
 * Null and `[]` are different answers and every surface tells them apart: null
 * is "there is nothing to ask with, connect GitHub", `[]` is "we asked, and
 * this account has the App installed nowhere — install it". Collapsing the two
 * would put the wrong door in front of the person.
 */
export interface GithubUserInstallationsDeps {
  candidates(
    scope: GithubUserInstallationScope,
  ): Promise<UserGithubInstallation[] | null>;
}

/** The encrypted-token envelope `ingestion.oauth_accounts` stores. */
interface EncryptedToken {
  keyId: string;
  ciphertext: string;
}

/**
 * The org's GitHub user access token, decrypted.
 *
 * `oauth_accounts` is keyed by org — one row per GitHub user per org — so this
 * is the "org's reusable user token" the API's own installations listing
 * resolves, read here on the tenant seam so RLS bounds it to this org.
 * Most-recently-refreshed wins, which is the rule the API applies too: a
 * re-authorization writes a fresher row, and that is the one whose reachability
 * answer is current.
 */
export async function resolveWorkspaceGithubUserToken(
  scope: GithubUserInstallationScope,
): Promise<WorkspaceGithubTokenResult> {
  const rows = await withTenantDb((tx) =>
    tx
      .select({ accessTokenEnc: schema.oauthAccounts.accessTokenEnc })
      .from(schema.oauthAccounts)
      .where(
        and(
          eq(schema.oauthAccounts.orgId, scope.orgId),
          eq(schema.oauthAccounts.provider, "github"),
        ),
      )
      .orderBy(desc(schema.oauthAccounts.updatedAt))
      .limit(1),
  );

  const enc = (rows[0]?.accessTokenEnc ?? null) as EncryptedToken | null;
  if (!enc) return { ok: false, reason: "no_account" };

  try {
    // Route by the envelope's stored keyId, not the current provider env — the
    // token may have been wrapped under a different provider than this runtime
    // is configured for.
    const { adapter } = resolveIngestionCryptoAdapterForKeyId(enc.keyId);
    const plain = await decrypt(
      Buffer.from(enc.ciphertext, "base64"),
      enc.keyId,
      { adapter },
    );
    return { ok: true, accessToken: plain.toString("utf8") };
  } catch (err) {
    logger.warn(
      { err: String(err), orgId: scope.orgId },
      "repository.github-user-installations: the stored GitHub token could not be decrypted",
    );
    return { ok: false, reason: "unreadable" };
  }
}

/**
 * GitHub answered the installations listing with a non-OK status. Carries the
 * status because each caller words it differently — the connector gate names it
 * in a 403 the operator reads, the settings capabilities let it surface as the
 * upstream failure it is — and a message that has lost the number cannot be
 * acted on.
 */
export class GithubUserInstallationsError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`GitHub answered ${status} listing the user's App installations`);
    this.name = "GithubUserInstallationsError";
    this.status = status;
  }
}

/** GitHub's own shape for one `/user/installations` row. */
interface GitHubInstallationRow {
  id: number | string;
  account?: {
    login?: string;
    type?: string;
    avatar_url?: string;
  } | null;
  repository_selection?: string;
}

const PER_PAGE = 100;
/**
 * Hard ceiling on pages walked. 100 × 100 is past any real account, and it is
 * what makes the loop provably terminate: the natural exit reads GitHub's
 * `total_count`, which is upstream-controlled and need not agree with the rows
 * actually returned — suspended installations are filtered out of the rows and
 * not out of the count, which would leave the count unreachable and spin this
 * against the GitHub API until the request timeout killed it.
 */
const MAX_PAGES = 100;

/**
 * Page `GET /user/installations` with a user access token.
 *
 * Throws {@link GithubUserInstallationsError} on a non-OK response rather than
 * answering an empty list: an account that has the App installed nowhere and an
 * account GitHub would not answer for are different facts, and only one of them
 * means "install the App". Fail closed — every caller treats the throw as "we
 * could not verify", never as "there is nothing there".
 */
export async function listUserGithubInstallations(
  accessToken: string,
): Promise<UserGithubInstallation[]> {
  const collected: UserGithubInstallation[] = [];
  let totalCount = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const resp = await fetch(
      `https://api.github.com/user/installations?per_page=${PER_PAGE}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "oxagen-ingestion/1.0",
        },
        // Paged loop — without a timeout one stalled page hangs the whole
        // capability, not just the page.
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!resp.ok) throw new GithubUserInstallationsError(resp.status);

    // Parsed from a remote response — every field is optional until proven.
    const data = (await resp.json()) as {
      total_count?: number;
      installations?: GitHubInstallationRow[];
    };
    totalCount = data.total_count ?? 0;
    const rows = data.installations ?? [];
    for (const row of rows) {
      collected.push({
        installationId: String(row.id),
        accountLogin: row.account?.login ?? null,
        accountType: row.account?.type ?? null,
        avatarUrl: row.account?.avatar_url || null,
        repositorySelection: row.repository_selection ?? null,
      });
    }
    // A short page is the last page, whatever `total_count` claims.
    if (rows.length < PER_PAGE) break;
    if (collected.length >= totalCount) break;
  }

  return collected;
}

/**
 * The production dependency both repository capabilities take: resolve the
 * workspace's stored GitHub token, then ask GitHub what it reaches.
 */
export const githubUserInstallationsDeps: GithubUserInstallationsDeps = {
  async candidates(scope) {
    const token = await resolveWorkspaceGithubUserToken(scope);
    if (!token.ok) return null;
    return listUserGithubInstallations(token.accessToken);
  },
};
