// tokens.ts: relay tokens, their hashes, and the in-memory verifier.
import { describe, expect, it } from "vitest";
import {
  generateRelayToken,
  hashRelayToken,
  memoryRelayTokenVerifier,
  RELAY_TOKEN_PREFIX,
  type RelayTokenRecord,
} from "./tokens";

const identity = {
  orgId: "org-1",
  workspaceId: "ws-1",
  workspacePublicId: "wrk_0123456789abcdefghjkmn",
  relay: "office",
};

describe("generateRelayToken", () => {
  it("is the prefix and 43 base64url characters, and never repeats", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateRelayToken()));
    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(token.startsWith(RELAY_TOKEN_PREFIX)).toBe(true);
      expect(token).toMatch(/^oxr_[A-Za-z0-9_-]{43}$/);
    }
  });
});

describe("hashRelayToken", () => {
  it("is the SHA-256 of the token in lowercase hex", () => {
    expect(hashRelayToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("memoryRelayTokenVerifier", () => {
  const token = generateRelayToken();
  const record: RelayTokenRecord = { ...identity, tokenHash: hashRelayToken(token) };

  it("returns the identity for a stored token, without its hash", async () => {
    const verifier = memoryRelayTokenVerifier([record]);
    const found = await verifier.verify(token);
    expect(found).toStrictEqual(identity);
    expect(found).not.toHaveProperty("tokenHash");
  });

  it("returns null for a token it does not hold", async () => {
    const verifier = memoryRelayTokenVerifier([record]);
    expect(await verifier.verify(generateRelayToken())).toBeNull();
    expect(await verifier.verify("")).toBeNull();
  });

  it("skips a stored hash of the wrong length instead of throwing", async () => {
    const verifier = memoryRelayTokenVerifier([{ ...identity, relay: "broken", tokenHash: "abcd" }, record]);
    expect(await verifier.verify(token)).toStrictEqual(identity);
  });

  it("picks the record whose hash matches among several", async () => {
    const other = generateRelayToken();
    const verifier = memoryRelayTokenVerifier([
      record,
      { ...identity, relay: "warehouse", tokenHash: hashRelayToken(other) },
    ]);
    expect((await verifier.verify(other))?.relay).toBe("warehouse");
  });
});
