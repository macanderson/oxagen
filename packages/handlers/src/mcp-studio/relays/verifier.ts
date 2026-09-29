// verifier.ts: the broker's relay token check, over mcp.relays (M12, #4685).
//
// A relay presents its token when it connects, and the broker asks this
// verifier again every 30 seconds while the relay stays connected. The
// verifier hashes the token and looks for a live row that holds the hash. A
// revoked row never matches, so revoke_relay takes effect at the next check.
//
// The lookup runs before any organization is known, so it reads the shared
// plane through withSystemDb. The matched row names its own organization and
// workspace. A token without the oxr_ prefix is refused before any query.
//
// Nothing here logs the token or its hash. A database error propagates, so
// the broker refuses the connect rather than treating the error as "no such
// relay".
import { withSystemDb } from "@oxagen/database";
import {
  hashRelayToken,
  RELAY_TOKEN_PREFIX,
  type RelayIdentity,
  type RelayTokenVerifier,
} from "@oxagen/relay-broker/tokens";
import { findLiveRelayByHash } from "./store";

export const postgresRelayTokenVerifier: RelayTokenVerifier = {
  async verify(token: string): Promise<RelayIdentity | null> {
    if (!token.startsWith(RELAY_TOKEN_PREFIX)) return null;
    const tokenHash = hashRelayToken(token);
    // tenancy: global lookup by the token's SHA-256 before any org scope exists; the matched row names its own orgId and workspaceId.
    const row = await withSystemDb((tx) => findLiveRelayByHash(tx, tokenHash));
    if (!row) return null;
    return {
      orgId: row.orgId,
      workspaceId: row.workspaceId,
      workspacePublicId: row.workspacePublicId,
      relay: row.name,
    };
  },
};
