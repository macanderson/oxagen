import { describe, expect, it } from "vitest";
import { digestBytes } from "../digest";
import { generateRunTokenKey, mintRunToken } from "../host/run-token";
import {
  type RedactionReason,
  redactBytes,
  redactionMarker,
  redactText,
} from "./redaction";

const enc = new TextEncoder();
const dec = new TextDecoder();

function reasonsIn(value: string): RedactionReason[] {
  return redactBytes(enc.encode(value)).redactions.map((r) => r.reason);
}

function redacted(value: string): string {
  return dec.decode(redactBytes(enc.encode(value)).bytes);
}

/** An Oxagen API key as `generateApiKey` mints it: `ox_` + base64url(32 bytes). */
const OX_KEY = `ox_${Buffer.from(
  Array.from({ length: 32 }, (_, index) => (index * 37 + 11) % 256),
).toString("base64url")}`;

const RUN_TOKEN = mintRunToken({
  key: generateRunTokenKey(),
  host: "tch_test",
  harness: "claude-code",
  provider: "anthropic",
  placement: "helper",
  now: Date.parse("2026-09-23T10:00:00.000Z"),
}).token;

const HEX64 = "0123456789abcdef".repeat(4);

// Vendor-shaped fixtures are assembled from parts so that a secret scanner
// reading this file does not take them for leaked credentials.
const GOOGLE_KEY = ["AI", "za", "SyD-9tSrke72PouQMnMX_7wz0a1b2c3d4e5"].join("");
const NPM_TOKEN = ["npm", "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6"].join("_");
const STRIPE_SECRET = ["sk", "live", "51HqLyjABCDEFGHIJKLMNOPQRSTUVWXYZ0"].join(
  "_",
);
const STRIPE_RESTRICTED = ["rk", "live", "51HqLyjABCDEFGHIJKLMNOPQRST"].join(
  "_",
);
const STRIPE_TEST = ["sk", "test", "51HqLyjABCDEFGHIJKLMNOPQRSTUVWXYZ0"].join(
  "_",
);
const GITLAB_PAT = ["glpat", "xYz12_AbCdEfGhIj-KLm"].join("-");

describe("detectors added by the audit", () => {
  it("builds fixtures in the real formats", () => {
    expect(OX_KEY).toHaveLength(3 + 43);
    expect(RUN_TOKEN.startsWith("oxrt_")).toBe(true);
    expect(GOOGLE_KEY).toHaveLength(4 + 35);
    expect(NPM_TOKEN).toHaveLength(4 + 36);
  });

  it.each([
    ["oxagen_api_key", OX_KEY],
    ["oxagen_run_token", RUN_TOKEN],
    ["google_api_key", GOOGLE_KEY],
    ["stripe_key", STRIPE_SECRET],
    ["stripe_key", STRIPE_RESTRICTED],
    ["gitlab_token", GITLAB_PAT],
    ["npm_token", NPM_TOKEN],
  ] as const)("recognises a %s", (reason, secret) => {
    const out = redactBytes(enc.encode(`x ${secret} y`));
    expect(out.redactions.map((r) => r.reason)).toEqual([reason]);
    expect(dec.decode(out.bytes)).toBe(`x ${redactionMarker(reason)} y`);
    expect(out.redactions[0]?.original_digest).toBe(digestBytes(secret));
  });

  it("recognises an Oxagen key wherever a config or header carries it", () => {
    expect(reasonsIn(`OXAGEN_API_KEY=${OX_KEY}`)).toEqual(["oxagen_api_key"]);
    expect(reasonsIn(`{"apiKey":"${OX_KEY}"}`)).toEqual(["oxagen_api_key"]);
    expect(redacted(`X-Api-Key: ${RUN_TOKEN}\n`)).toBe(
      `X-Api-Key: ${redactionMarker("oxagen_run_token")}\n`,
    );
  });

  it("removes a whole run token presented as a bearer", () => {
    const out = redacted(`Authorization: Bearer ${RUN_TOKEN}`);
    expect(out).not.toContain("oxrt_");
    expect(out).not.toContain(RUN_TOKEN.split(".")[1]);
  });

  it.each([
    ["an event id", `evt_${HEX64}`],
    ["a digest", `sha256:${HEX64}`],
    ["a run token id", "rt_0123456789abcdef0123"],
    ["an API key's stored prefix", "ox_liveliveli"],
    ["an identifier that starts ox_", "ox_enforcement_tier"],
    ["ox_ with too long a tail", `ox_${HEX64}`],
    ["ox_ inside a longer word", `box_${OX_KEY.slice(3)}`],
    ["the run token prefix in prose", "tokens start with oxrt_ and a dot."],
    [
      "an npm config variable",
      "npm_config_registry=https://registry.npmjs.org",
    ],
    ["a Stripe test key", STRIPE_TEST],
    ["a short AIza word", "AIzaShortValue"],
    ["an AIza word with too long a tail", `${GOOGLE_KEY}0`],
    ["an npm_ word with too long a tail", `${NPM_TOKEN}0`],
    ["glpat- with a short tail", "glpat-short"],
    ["the bearer scheme in prose", "a bearer token is sent on each call"],
    ["a UUID", "3f2c7b1e-9a4d-4c8e-b2f1-6d5e4a3b2c1d"],
  ])("does not flag %s", (_label, value) => {
    expect(reasonsIn(value)).toEqual([]);
  });
});

describe("bearer header", () => {
  it.each(["bearer", "BEARER", "Bearer", "bEaReR"])(
    "matches the %s scheme in any case",
    (scheme) => {
      const token = "abcdefghijklmnopqrstuvwxyz012345";
      expect(redacted(`authorization: ${scheme} ${token}`)).toBe(
        `authorization: ${scheme} ${redactionMarker("bearer_token")}`,
      );
    },
  );

  it("removes a token with an underscore whole", () => {
    const token = "abcdefghijklmnopqrstu_vwxyz0123456789SECRET";
    expect(redacted(`Authorization: Bearer ${token}`)).toBe(
      `Authorization: Bearer ${redactionMarker("bearer_token")}`,
    );
  });
});

describe("private key blocks", () => {
  it("redacts a PGP private key block", () => {
    const pgp = [
      "-----BEGIN PGP PRIVATE KEY BLOCK-----",
      "Version: GnuPG v2.0.22 (GNU/Linux)",
      "",
      "lQOYBFxyzABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
      "=abcd",
      "-----END PGP PRIVATE KEY BLOCK-----",
    ].join("\n");
    expect(redacted(`before\n${pgp}\nafter`)).toBe(
      `before\n${redactionMarker("private_key")}\nafter`,
    );
  });

  it("redacts a PEM block cut off before its END line", () => {
    const cut =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn\nAbCdEfGhIjKlMnOp";
    expect(redacted(`cat id_rsa\n${cut}`)).toBe(
      `cat id_rsa\n${redactionMarker("private_key")}`,
    );
    // The text after the key material is kept.
    expect(redacted(`${cut}\n[output truncated]`)).toBe(
      `${redactionMarker("private_key")}\n[output truncated]`,
    );
  });

  it("redacts a cut-off key inside a JSON string and keeps the JSON", () => {
    const cut =
      "-----BEGIN OPENSSH PRIVATE KEY-----\\nb3BlbnNzaC1rZXktdjEAAAAA\\nBG5vbmUAAAAEbm9uZQ";
    expect(redacted(`{"output":"${cut}","truncated":true}`)).toBe(
      `{"output":"${redactionMarker("private_key")}","truncated":true}`,
    );
  });

  it("redacts a cut-off encrypted PEM through its headers", () => {
    const cut = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "Proc-Type: 4,ENCRYPTED",
      "DEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF",
      "",
      "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn",
    ].join("\n");
    expect(redacted(`${cut}\n$ next`)).toBe(
      `${redactionMarker("private_key")}\n$ next`,
    );
  });

  it("does not stretch a cut-off key to a later key's END line", () => {
    const cut = "-----BEGIN RSA PRIVATE KEY-----\nMIIEcut";
    const whole =
      "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEE\n-----END EC PRIVATE KEY-----";
    const out = redactBytes(enc.encode(`${cut}\n$ ok\n${whole}\ndone`));
    expect(dec.decode(out.bytes)).toBe(
      `${redactionMarker("private_key")}\n$ ok\n${redactionMarker("private_key")}\ndone`,
    );
    expect(out.redactions).toHaveLength(2);
  });

  it("stays linear over many cut-off keys", () => {
    const parts: string[] = [];
    for (let index = 0; index < 4_000; index += 1)
      parts.push(
        `-----BEGIN RSA PRIVATE KEY-----\nMIIE${index}\n${"x".repeat(200)};`,
      );
    const startedAt = Date.now();
    const out = redactBytes(enc.encode(parts.join("\n")));
    expect(out.redactions).toHaveLength(4_000);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});

describe("redactText", () => {
  it("replaces each credential with its marker", () => {
    expect(redactText(`use ${OX_KEY} and ${"AKIAABCDEFGHIJKLMNOP"}`)).toBe(
      `use ${redactionMarker("oxagen_api_key")} and ${redactionMarker("aws_access_key")}`,
    );
  });

  it("returns clean text unchanged", () => {
    expect(redactText(`evt_${HEX64}`)).toBe(`evt_${HEX64}`);
  });

  it("leaves markers alone on a second pass", () => {
    const once = redactText(`Bearer ${RUN_TOKEN} ${OX_KEY}`);
    expect(redactText(once)).toBe(once);
  });
});
