import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DONE_BADGE_PATH,
  DONE_KEY_PATH,
  doneAttestationKey,
  doneBadgeUrl,
  mintDoneBadgeToken,
  readDoneBadgeToken,
  renderDoneBadge,
  type DoneAttestationKey,
  type DoneBadgeClaims,
  type DoneBadgeState,
} from "./index";

const CLAIMS: DoneBadgeClaims = {
  orgId: "0f6c2d7e-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
  workspaceId: "5e4d3c2b-1a0f-4e9d-8c7b-6a5f4e3d2c1b",
  item: "wi_0123456789ABCDEFGHJKMN",
};

function newKey(): DoneAttestationKey {
  return doneAttestationKey(generateKeyPairSync("ed25519").privateKey);
}

/** A token over any claims text, signed the way mintDoneBadgeToken signs. */
function signedToken(key: DoneAttestationKey, claimsText: string): string {
  const claimsPart = Buffer.from(claimsText, "utf8").toString("base64url");
  const sig = sign(
    null,
    Buffer.from(`oxagen.work-done-badge.v1\n${claimsPart}`, "utf8"),
    key.privateKey,
  );
  return `${claimsPart}.${sig.toString("base64url")}`;
}

describe("badge tokens", () => {
  it("reads back the claims it minted", () => {
    const key = newKey();
    const token = mintDoneBadgeToken(CLAIMS, key);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(readDoneBadgeToken(token, key.publicKeyPem)).toEqual(CLAIMS);
  });

  it("mints the same token for the same claims", () => {
    const key = newKey();
    expect(mintDoneBadgeToken(CLAIMS, key)).toBe(mintDoneBadgeToken(CLAIMS, key));
  });

  it.each([
    ["an org id that is not a UUID", { ...CLAIMS, orgId: "acme" }],
    ["an uppercase workspace id", { ...CLAIMS, workspaceId: CLAIMS.workspaceId.toUpperCase() }],
    ["a bad work item id", { ...CLAIMS, item: "wi_" as DoneBadgeClaims["item"] }],
  ])("refuses to mint a token for %s", (_name, claims) => {
    expect(() => mintDoneBadgeToken(claims, newKey())).toThrow(
      /orgId and workspaceId must be lowercase UUIDs/,
    );
  });

  it("refuses a token another key signed", () => {
    const token = mintDoneBadgeToken(CLAIMS, newKey());
    expect(readDoneBadgeToken(token, newKey().publicKeyPem)).toBeNull();
  });

  it("refuses a token whose claims changed after signing", () => {
    const key = newKey();
    const [, sig] = mintDoneBadgeToken(CLAIMS, key).split(".");
    const other = Buffer.from(
      JSON.stringify({ item: CLAIMS.item, org: CLAIMS.workspaceId, v: 1, ws: CLAIMS.workspaceId }),
      "utf8",
    ).toString("base64url");
    expect(readDoneBadgeToken(`${other}.${sig ?? ""}`, key.publicKeyPem)).toBeNull();
  });

  it.each([
    ["a token over 1024 characters", "a".repeat(1025)],
    ["a token with one part", "abc"],
    ["a token with three parts", "a.b.c"],
    ["claims that are not base64url", "a+b.c"],
    ["a signature that is not base64url", "abc.d/e"],
    ["a signature that is not 64 bytes", "abc.def"],
  ])("refuses %s", (_name, token) => {
    expect(readDoneBadgeToken(token, newKey().publicKeyPem)).toBeNull();
  });

  const valid = { v: 1, org: CLAIMS.orgId, ws: CLAIMS.workspaceId, item: CLAIMS.item };
  it.each([
    ["claims that are not JSON", "{"],
    ["claims that are a number", "1"],
    ["claims that are null", "null"],
    ["another token version", JSON.stringify({ ...valid, v: 2 })],
    ["a numeric org", JSON.stringify({ ...valid, org: 1 })],
    ["a missing workspace", JSON.stringify({ ...valid, ws: undefined })],
    ["a numeric item", JSON.stringify({ ...valid, item: 7 })],
    ["an org that is not a UUID", JSON.stringify({ ...valid, org: "acme" })],
  ])("refuses a signed token holding %s", (_name, claimsText) => {
    const key = newKey();
    expect(readDoneBadgeToken(signedToken(key, claimsText), key.publicKeyPem)).toBeNull();
  });

  it("accepts claims a signer wrote by hand in the same shape", () => {
    const key = newKey();
    expect(readDoneBadgeToken(signedToken(key, JSON.stringify(valid)), key.publicKeyPem)).toEqual(
      CLAIMS,
    );
  });

  it("throws when the caller's public key is not ed25519", () => {
    const token = mintDoneBadgeToken(CLAIMS, newKey());
    const ed448 = generateKeyPairSync("ed448")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    expect(() => readDoneBadgeToken(token, ed448)).toThrow(TypeError);
  });
});

describe("doneBadgeUrl", () => {
  it("joins the API origin, the badge path, and the token", () => {
    expect(doneBadgeUrl("https://api.oxagen.sh//", "abc.def")).toBe(
      "https://api.oxagen.sh/v1/work/done/badge/abc.def.svg",
    );
    expect(DONE_BADGE_PATH).toBe("/v1/work/done/badge");
    expect(DONE_KEY_PATH).toBe("/v1/work/done/key");
  });
});

describe("renderDoneBadge", () => {
  it.each<[DoneBadgeState, string, string]>([
    ["pending", "pending", "#2E6BA8"],
    ["held", "held", "#2F7D52"],
    ["proven", "proven", "#1F7676"],
    ["broken", "broken", "#992F28"],
    ["none", "no record", "#71717A"],
  ])("draws the %s badge", (state, text, color) => {
    const svg = renderDoneBadge(state);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain(`aria-label="Oxagen done: ${text}"`);
    expect(svg).toContain(`<title>Oxagen done: ${text}</title>`);
    expect(svg).toContain(`fill="${color}"`);
    expect(svg).toContain(`>${text}</text>`);
    expect(svg.endsWith("</svg>")).toBe(true);
  });

  it("widens the badge to fit the longer value", () => {
    const width = (svg: string) => Number(/width="(\d+)"/.exec(svg)?.[1]);
    expect(width(renderDoneBadge("none"))).toBeGreaterThan(width(renderDoneBadge("held")));
  });
});
