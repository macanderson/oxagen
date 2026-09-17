// The two fields that disqualify a credential, in the order the server checks
// them. Every case names the refusal it mirrors.
import { describe, expect, it } from "vitest";
import { credentialState } from "./credential-state";

const NOW = Date.parse("2026-09-16T12:00:00.000Z");
const PAST = "2026-09-15T12:00:00.000Z";
const FUTURE = "2099-09-15T12:00:00.000Z";

describe("credentialState", () => {
  it("is live for a credential with neither field set", () => {
    expect(credentialState({ expiresAt: null, revokedAt: null }, NOW)).toBe(
      "live",
    );
  });

  it("is live for a credential whose expiry is still ahead", () => {
    expect(credentialState({ expiresAt: FUTURE, revokedAt: null }, NOW)).toBe(
      "live",
    );
  });

  it("is expired the instant the expiry is reached, not after it (boundary)", () => {
    // resolveApiKey refuses a key whose expiry is at or before now.
    const at = new Date(NOW).toISOString();
    expect(credentialState({ expiresAt: at, revokedAt: null }, NOW)).toBe(
      "expired",
    );
  });

  it("is expired for a credential whose expiry has passed", () => {
    expect(credentialState({ expiresAt: PAST, revokedAt: null }, NOW)).toBe(
      "expired",
    );
  });

  it("is revoked for a revoked credential, whatever its expiry", () => {
    expect(credentialState({ expiresAt: FUTURE, revokedAt: PAST }, NOW)).toBe(
      "revoked",
    );
  });

  it("names revocation first for a credential that is both revoked and expired", () => {
    // tacho-host.ts refuses a revoked enrollment before it looks at the expiry,
    // so the page says the same thing the server would.
    expect(credentialState({ expiresAt: PAST, revokedAt: PAST }, NOW)).toBe(
      "revoked",
    );
  });
});
