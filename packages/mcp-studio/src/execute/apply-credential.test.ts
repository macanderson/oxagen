// apply-credential.ts: where an HTTP request carries the credential.
import { describe, expect, it } from "vitest";
import type { ManifestAuth } from "../contract/manifest";
import { placeCredential } from "./apply-credential";
import { BuildError } from "./util";

const oauth: ManifestAuth = { mode: "service", scheme: "oauth", apply: { type: "oauth2" } };

function apiKey(where: "header" | "query" | "cookie", name: string): ManifestAuth {
  return { mode: "service", scheme: "key", apply: { type: "api_key", in: where, name } };
}

function refusal(run: () => unknown): BuildError {
  try {
    run();
  } catch (error) {
    if (error instanceof BuildError) return error;
    throw error;
  }
  throw new Error("expected a BuildError");
}

describe("placeCredential", () => {
  it("adds nothing for no credential", () => {
    expect(placeCredential(null, { type: "none" }, "cloud")).toEqual({
      headers: [],
      query: [],
      cookies: [],
      relay_credential: undefined,
    });
  });

  it("puts a bearer token in Authorization", () => {
    expect(placeCredential(oauth, { type: "bearer", token: "tok_1" }, "cloud").headers).toEqual([
      ["Authorization", "Bearer tok_1"],
    ]);
  });

  it("puts a basic pair in Authorization as base64", () => {
    const placed = placeCredential(null, { type: "basic", username: "ada", password: "pässword" }, "cloud");
    expect(placed.headers).toEqual([["Authorization", `Basic ${Buffer.from("ada:pässword").toString("base64")}`]]);
  });

  it("refuses a basic user name with a colon", () => {
    const error = refusal(() => placeCredential(null, { type: "basic", username: "a:b", password: "p" }, "cloud"));
    expect(error.title).toBe("Invalid credential");
    expect(error.message).toContain("colon");
  });

  it("puts an API key where the scheme says", () => {
    expect(placeCredential(apiKey("header", "X-Api-Key"), { type: "api_key", value: "k1" }, "cloud")).toEqual({
      headers: [["X-Api-Key", "k1"]],
      query: [],
      cookies: [],
      relay_credential: undefined,
    });
    expect(placeCredential(apiKey("query", "api_key"), { type: "api_key", value: "k 2" }, "cloud").query).toEqual([
      ["api_key", "k 2"],
    ]);
    expect(placeCredential(apiKey("cookie", "session"), { type: "api_key", value: "k3" }, "cloud").cookies).toEqual([
      ["session", "k3"],
    ]);
  });

  it("refuses an API key with no api_key scheme", () => {
    expect(refusal(() => placeCredential(oauth, { type: "api_key", value: "k" }, "cloud")).title).toBe(
      "Invalid credential",
    );
    expect(refusal(() => placeCredential(null, { type: "api_key", value: "k" }, "cloud")).title).toBe(
      "Invalid credential",
    );
  });

  it("refuses a cookie key a cookie cannot carry", () => {
    const error = refusal(() => placeCredential(apiKey("cookie", "session"), { type: "api_key", value: "a;b" }, "cloud"));
    expect(error.message).toContain("cookie");
  });

  it("refuses a line break or NUL without quoting the secret", () => {
    for (const token of ["a\r\nX-Evil: 1", "a\nb", "a\0b"]) {
      const error = refusal(() => placeCredential(oauth, { type: "bearer", token }, "cloud"));
      expect(error.title).toBe("Invalid credential");
      expect(error.message).not.toContain(token);
    }
    expect(refusal(() => placeCredential(null, { type: "basic", username: "u", password: "p\n" }, "cloud")).title).toBe(
      "Invalid credential",
    );
    expect(
      refusal(() => placeCredential(apiKey("header", "X-Key"), { type: "api_key", value: "v\r" }, "cloud")).title,
    ).toBe("Invalid credential");
  });

  it("passes a relay credential beside the request on a relay network", () => {
    const credential = { name: "billing-token", scheme: "bearer" as const };
    expect(placeCredential(oauth, { type: "relay", credential }, "relay:a-intel-east")).toEqual({
      headers: [],
      query: [],
      cookies: [],
      relay_credential: credential,
    });
  });

  it("refuses a relay credential off a relay network", () => {
    const error = refusal(() =>
      placeCredential(oauth, { type: "relay", credential: { name: "billing-token", scheme: "bearer" } }, "cloud"),
    );
    expect(error.message).toContain("relay network");
  });
});
