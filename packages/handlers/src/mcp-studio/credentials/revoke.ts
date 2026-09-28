// revoke.ts: end an operator's connection to a server (mcp-studio-spec,
// Authentication).
//
// An operator's token is revoked when the operator disconnects the server and
// when the operator leaves the workspace. Oxagen asks the authorization
// server to revoke the refresh token and the access token (RFC 7009), then
// deletes the row. The row goes even when the server refuses or cannot be
// reached, so Oxagen stops using the token either way.
import {
  decryptCredentialSecrets,
  resolveCredentialKms,
  type ResolvedKms,
} from "@oxagen/plugins";
import { type FetchLike, type OAuthClient, revokeToken } from "./oauth";
import {
  type CredentialScope,
  type CredentialStore,
  postgresCredentialStore,
  type StoredOperatorToken,
} from "./store";

export interface RevokeDeps {
  store: CredentialStore;
  /** The vault key. Defaults to resolveCredentialKms(). */
  kms?: ResolvedKms | null;
  fetch?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Ask the authorization server to revoke the row's tokens. Answers true when
 * the server accepted every revocation it was sent, and when there was
 * nothing to send. Answers false when the vault key is missing, or the server
 * refused or could not be reached.
 */
export async function revokeAtServer(
  row: StoredOperatorToken,
  deps: RevokeDeps,
): Promise<boolean> {
  if (row.revocationEndpoint === null) return true;
  const kms = deps.kms === undefined ? resolveCredentialKms() : deps.kms;
  if (kms === null) return false;
  const secrets = await decryptCredentialSecrets(
    {
      tokenKmsKeyId: row.tokenKmsKeyId,
      accessTokenEnc: row.accessTokenEnc,
      refreshTokenEnc: row.refreshTokenEnc,
      oauthClientSecretEnc: row.clientSecretEnc,
    },
    kms,
  );
  let clientSecret = secrets.oauthClientSecret;
  if (clientSecret === null && row.credentialId !== null) {
    // A named client keeps its secret on its mcp.credentials row.
    const named = await deps.store.credentialById(row.credentialId);
    if (named !== null) {
      clientSecret = (await decryptCredentialSecrets(named, kms)).oauthClientSecret;
    }
  }
  const client: OAuthClient = { clientId: row.clientId, clientSecret };
  const options = {
    fetch: deps.fetch ?? ((input: string, init: RequestInit) => fetch(input, init)),
    signal: deps.signal ?? new AbortController().signal,
    timeoutMs: deps.timeoutMs,
  };
  const endpoint = row.revocationEndpoint;
  // Revoking the refresh token ends the grant at most servers. The access
  // token goes too, for a server that revokes one token at a time.
  const sent: Promise<boolean>[] = [];
  if (secrets.refreshToken !== null) {
    sent.push(
      revokeToken(
        { revocationEndpoint: endpoint, client, token: secrets.refreshToken, hint: "refresh_token" },
        options,
      ),
    );
  }
  if (secrets.accessToken !== null) {
    sent.push(
      revokeToken(
        { revocationEndpoint: endpoint, client, token: secrets.accessToken, hint: "access_token" },
        options,
      ),
    );
  }
  return (await Promise.all(sent)).every(Boolean);
}

/**
 * Revoke one operator token at the authorization server, then delete the row.
 * Answers what revokeAtServer answered.
 */
export async function revokeOperatorToken(
  row: StoredOperatorToken,
  deps: RevokeDeps,
): Promise<boolean> {
  const accepted = await revokeAtServer(row, deps);
  await deps.store.deleteOperatorToken(row.id);
  return accepted;
}

/** Revoke and delete every token one operator holds in the store's workspace. Answers how many. */
export async function revokeOperatorTokens(userId: string, deps: RevokeDeps): Promise<number> {
  const rows = await deps.store.operatorTokensOf(userId);
  for (const row of rows) await revokeOperatorToken(row, deps);
  return rows.length;
}

/**
 * The call for the path that removes a person from a workspace: revoke every
 * server token they connected there. Run it after the removal commits, so a
 * removal that rolls back keeps the tokens.
 */
export function revokeDepartedOperator(
  input: CredentialScope & { userId: string },
  deps: Omit<RevokeDeps, "store"> = {},
): Promise<number> {
  const store = postgresCredentialStore({ orgId: input.orgId, workspaceId: input.workspaceId });
  return revokeOperatorTokens(input.userId, { ...deps, store });
}
