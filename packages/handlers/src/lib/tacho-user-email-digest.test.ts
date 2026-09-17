/**
 * The stored person-digest must be one-way for whoever can read the column
 * (#3072), and one value per person however the collector spelled it.
 */
import { createHash } from "node:crypto";
import { digestUserEmail } from "@oxagen/tacho";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  keyedUserEmailDigest,
  resetUserEmailDigestWarningForTests,
  stampUserEmailDigest,
  userEmailPreimage,
  USER_EMAIL_DIGEST_KEY_ENV,
} from "./tacho-user-email-digest";

const ADDRESS = "Ada.Lovelace@example.com";
const NORMALIZED = "ada.lovelace@example.com";
const KEY = "a-key-only-the-control-plane-holds";

beforeEach(() => {
  resetUserEmailDigestWarningForTests();
  vi.stubEnv(USER_EMAIL_DIGEST_KEY_ENV, KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the stored digest is keyed", () => {
  it("cannot be reproduced by someone who guesses the address", () => {
    // THE FINDING. A reader of tacho_events knows the schema, the domain
    // separators and their colleagues' addresses. Every unkeyed value they can
    // compute from that must differ from what is stored, or the column is the
    // address again in a thin disguise.
    const stored = stampUserEmailDigest({ user_email: ADDRESS }) as string;
    const guesses = [
      // a bare hash of the address
      createHash("sha256")
        .update(NORMALIZED)
        .digest("hex"),
      // the published domain-separated pre-image, in both spellings
      digestUserEmail(ADDRESS) as string,
      (digestUserEmail(ADDRESS) as string).replace("sha256:", ""),
      // the pre-image re-hashed, in case the server simply hashed it again
      createHash("sha256")
        .update(digestUserEmail(ADDRESS) as string)
        .digest("hex"),
      // the domain this module names, hashed without the key
      createHash("sha256")
        .update("oxagen.tacho.user-email-digest.v1")
        .update("\0")
        .update(digestUserEmail(ADDRESS) as string)
        .digest("hex"),
    ];
    for (const guess of guesses) {
      expect(stored).not.toBe(guess);
      expect(stored).not.toBe(`sha256:${guess}`);
      expect(stored).not.toBe(`hmac-sha256:${guess}`);
      expect(stored).not.toContain(guess);
    }
  });

  it("changes completely when the key changes, so the key is what carries it", () => {
    const underOneKey = stampUserEmailDigest({ user_email: ADDRESS });
    vi.stubEnv(USER_EMAIL_DIGEST_KEY_ENV, `${KEY}-rotated`);
    expect(stampUserEmailDigest({ user_email: ADDRESS })).not.toBe(underOneKey);
  });

  it("says out loud that it is keyed", () => {
    // A reader who sees `sha256:` on a low-entropy input is entitled to assume
    // they can reverse it. This prefix tells them the shape they are looking at.
    expect(stampUserEmailDigest({ user_email: ADDRESS })).toMatch(
      /^hmac-sha256:[0-9a-f]{64}$/,
    );
  });

  it("never contains the address", () => {
    const stored = stampUserEmailDigest({ user_email: ADDRESS }) as string;
    expect(stored.toLowerCase()).not.toContain(NORMALIZED);
    expect(stored).not.toContain("@");
  });
});

describe("one person, one value", () => {
  it("gives a legacy collector and a current one the same stored value", () => {
    // A fleet part-way through an upgrade must not split one person in two.
    const fromLegacyAddress = stampUserEmailDigest({ user_email: ADDRESS });
    const fromHostPreimage = stampUserEmailDigest({
      user_email_digest: digestUserEmail(ADDRESS) as string,
    });
    expect(fromHostPreimage).toBe(fromLegacyAddress);
  });

  it("normalizes case and surrounding space on the legacy path", () => {
    const expected = stampUserEmailDigest({ user_email: NORMALIZED });
    expect(stampUserEmailDigest({ user_email: `  ${ADDRESS} ` })).toBe(
      expected,
    );
    expect(
      stampUserEmailDigest({ user_email: "ADA.LOVELACE@EXAMPLE.COM" }),
    ).toBe(expected);
  });

  it("prefers the host pre-image when a collector sends both", () => {
    const preimage = digestUserEmail("someone.else@example.com") as string;
    expect(
      userEmailPreimage({ user_email_digest: preimage, user_email: ADDRESS }),
    ).toBe(preimage);
  });

  it("distinguishes two people", () => {
    expect(stampUserEmailDigest({ user_email: "a@example.com" })).not.toBe(
      stampUserEmailDigest({ user_email: "b@example.com" }),
    );
  });
});

describe("nothing to digest", () => {
  it("yields nothing for an absent block or an empty address", () => {
    expect(stampUserEmailDigest(undefined)).toBeUndefined();
    expect(stampUserEmailDigest(null)).toBeUndefined();
    expect(stampUserEmailDigest({})).toBeUndefined();
    expect(stampUserEmailDigest({ user_email: "" })).toBeUndefined();
    expect(stampUserEmailDigest({ user_email: "   " })).toBeUndefined();
    expect(keyedUserEmailDigest(undefined)).toBeUndefined();
  });
});

describe("a deployment holding no key", () => {
  it("records no digest rather than falling back to a reversible one", () => {
    // Failing closed on the DATA. The attribute is lost; no address is stored,
    // and no value a reader could reverse takes its place.
    vi.stubEnv(USER_EMAIL_DIGEST_KEY_ENV, "");
    expect(stampUserEmailDigest({ user_email: ADDRESS })).toBeUndefined();
    expect(
      stampUserEmailDigest({
        user_email_digest: digestUserEmail(ADDRESS) as string,
      }),
    ).toBeUndefined();
  });

  it("keeps ingestion working rather than taking a fleet's telemetry down", () => {
    vi.stubEnv(USER_EMAIL_DIGEST_KEY_ENV, "");
    expect(() => stampUserEmailDigest({ user_email: ADDRESS })).not.toThrow();
  });
});
