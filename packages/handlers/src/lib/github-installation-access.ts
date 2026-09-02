import { schema, withTenantDb } from "@oxagen/database";
import { and, desc, eq } from "drizzle-orm";
import { decrypt, resolveIngestionCryptoAdapterForKeyId } from "@oxagen/crypto";
import { HTTPException } from "hono/http-exception";

interface EncryptedToken {
  keyId: string;
  ciphertext: string;
}

/**
 * Authorization gate for binding a GitHub App installation to a workspace's
 * connection.
 *
 * A GitHub App installation is a shared, singleton-per-account resource, and the
 * Oxagen server holds GITHUB_APP_PRIVATE_KEY — so ANY workspace that writes a
 * valid `installationId` onto a connection can mint an installation token
 * (packages/handlers/src/lib/github-token.ts, ADR-020) and read that org's
 * private repos, REGARDLESS of the acting user's GitHub access. The only thing
 * that makes attaching safe is proving the acting user can actually reach the
 * installation on GitHub. GitHub itself is the oracle: `GET /user/installations`
 * returns exactly the installations the user's OAuth token can see (org
 * membership + granted repo access). We confirm the requested id is in that set;
 * otherwise we refuse the write.
 *
 * Fail-closed: if the workspace has no usable GitHub OAuth token (never
 * connected, or the token was revoked/expired), we cannot verify access, so we
 * reject with an actionable 403 rather than silently allowing the bind. The
 * install/OAuth callback (github-oauth.ts) is exempt — its installationId comes
 * from GitHub's HMAC-verified redirect, not from client input.
 */
export async function assertGithubInstallationAccessible(
  ctx: { orgId: string; workspaceId: string },
  installationId: string | number,
): Promise<void> {
  const targetId = String(installationId);

  // The workspace's org GitHub OAuth token. oauth_accounts is org-keyed (one row
  // per GitHub user per org); most-recently-refreshed wins. RLS (org_only) plus
  // the explicit orgId filter bound this to the caller's org.
  const [account] = await withTenantDb((tx) =>
    tx
      .select({ accessTokenEnc: schema.oauthAccounts.accessTokenEnc })
      .from(schema.oauthAccounts)
      .where(
        and(
          eq(schema.oauthAccounts.orgId, ctx.orgId),
          eq(schema.oauthAccounts.provider, "github"),
        ),
      )
      .orderBy(desc(schema.oauthAccounts.updatedAt))
      .limit(1),
  );

  if (!account?.accessTokenEnc) {
    throw new HTTPException(403, {
      message:
        "Cannot verify GitHub access for this installation — connect GitHub for this workspace first.",
    });
  }

  let userToken: string;
  try {
    const enc = account.accessTokenEnc as EncryptedToken;
    // Route by the envelope's stored keyId, not the current provider env — the
    // token may have been wrapped under a different provider than this runtime.
    const { adapter } = resolveIngestionCryptoAdapterForKeyId(enc.keyId);
    const plain = await decrypt(
      Buffer.from(enc.ciphertext, "base64"),
      enc.keyId,
      { adapter },
    );
    userToken = plain.toString("utf8");
  } catch {
    throw new HTTPException(403, {
      message:
        "Cannot verify GitHub access for this installation — the stored GitHub token is unreadable; reconnect GitHub.",
    });
  }

  if (!(await userCanReachInstallation(userToken, targetId))) {
    throw new HTTPException(403, {
      message:
        `You do not have access to GitHub installation ${targetId}. ` +
        "Pick an organization the connected GitHub account can access, or install the Oxagen app on it.",
    });
  }
}

const PER_PAGE = 100;
// 5,000 installations is far more than any account reaches; the ceiling exists
// only so a server that keeps reporting a total it never delivers cannot spin
// the loop forever.
const MAX_PAGES = 50;

/**
 * True if `GET /user/installations` (paged) contains `installationId`. Throws a
 * 403 on a non-OK GitHub response (revoked/expired token) — fail-closed: we must
 * not allow the bind when we cannot verify access.
 *
 * Pagination stops on the first page that comes back empty, and at MAX_PAGES
 * regardless: `total_count` is the server's claim, and trusting it alone means
 * an inconsistent or truncated response (a concurrent uninstall, a filtered
 * page) leaves `seen < total` forever while every further page returns nothing.
 */
async function userCanReachInstallation(
  userToken: string,
  installationId: string,
): Promise<boolean> {
  let page = 1;
  let total = 0;
  let seen = 0;

  do {
    const resp = await fetch(
      `https://api.github.com/user/installations?per_page=${PER_PAGE}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${userToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "oxagen-ingestion/1.0",
        },
        // This runs in a paged do/while — without a timeout one stalled
        // GitHub page hangs the whole capability, not just one request.
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!resp.ok) {
      throw new HTTPException(403, {
        message:
          `Could not verify GitHub installation access (GitHub returned ${resp.status}). ` +
          "Reconnect GitHub for this workspace and try again.",
      });
    }

    // Parsed from a remote response — every field is optional until proven.
    const data = (await resp.json()) as {
      total_count?: number;
      installations?: Array<{ id: number | string }>;
    };
    total = data.total_count ?? 0;
    const installations = data.installations ?? [];
    for (const inst of installations) {
      if (String(inst.id) === installationId) return true;
      seen++;
    }
    // An empty page means the listing is exhausted, whatever total_count says.
    if (installations.length === 0) break;
    page++;
  } while (seen < total && page <= MAX_PAGES);

  return false;
}
