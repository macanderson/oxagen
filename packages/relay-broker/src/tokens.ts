// tokens.ts: relay tokens, and the port the broker checks them through.
//
// A relay authenticates with a relay token when it connects. Oxagen stores
// only the token's SHA-256, so a leaked database row cannot connect a relay.
// The record behind a token names the organization, the workspace, and the
// relay, and the broker routes calls by exactly those three. The records live
// in the mcp.relays table, and postgresRelayTokenVerifier in
// packages/handlers/src/mcp-studio/relays/verifier.ts reads them. The
// in-memory verifier below serves tests and a host app that loads its relays
// at start.
//
// The broker checks each live connection's token again every 30 seconds
// (DEFAULT_REVOCATION_CHECK_MS), so a revoked token stops working within 30
// seconds, even on a relay that is already connected.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** The organization, workspace, and relay a token belongs to. */
export interface RelayIdentity {
  orgId: string;
  /** The workspace's internal id, for routing. */
  workspaceId: string;
  /** The workspace's public id, wrk_…, which envelopes name. */
  workspacePublicId: string;
  /** The relay's name, as network = relay:<name> names it. */
  relay: string;
}

export interface RelayTokenVerifier {
  /** The identity a token belongs to, or null when no live record holds its hash. */
  verify(token: string): Promise<RelayIdentity | null>;
}

/** The prefix every relay token starts with, so a scanner can spot one. */
export const RELAY_TOKEN_PREFIX = "oxr_";

/** A new relay token: the prefix and 32 random bytes in base64url. Show it once and store its hash. */
export function generateRelayToken(): string {
  return `${RELAY_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** The SHA-256 of a token, in lowercase hex. This is the only form Oxagen stores. */
export function hashRelayToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** One stored relay record: the identity and the hash of its token. */
export interface RelayTokenRecord extends RelayIdentity {
  tokenHash: string;
}

/**
 * A verifier over records held in memory, for tests and for a host app that
 * loads its relays at start. It compares hashes in constant time.
 */
export function memoryRelayTokenVerifier(records: readonly RelayTokenRecord[]): RelayTokenVerifier {
  return {
    verify(token) {
      const hash = Buffer.from(hashRelayToken(token), "hex");
      for (const record of records) {
        const stored = Buffer.from(record.tokenHash, "hex");
        if (stored.length === hash.length && timingSafeEqual(stored, hash)) {
          const { tokenHash: _hash, ...identity } = record;
          return Promise.resolve(identity);
        }
      }
      return Promise.resolve(null);
    },
  };
}
