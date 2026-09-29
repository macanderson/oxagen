// credentials.test.ts: the variable each credential reads, and the header addCredential adds to a request.
import { describe, expect, it } from "vitest";
import { addCredential, credentialEnvName, type CredentialOutcome, type HeaderEntry, type RelayCredential } from "./credentials";
import { testCertificate } from "./test/certificate";

const BEARER: RelayCredential = { name: "billing-api", scheme: "bearer" };
const BASIC: RelayCredential = { name: "billing-api", scheme: "basic" };
const HEADER: RelayCredential = { name: "billing-api", scheme: "header", header: "X-Api-Key" };

const TOKEN_VAR = "RELAY_CREDENTIAL_BILLING_API_TOKEN";
const USERNAME_VAR = "RELAY_CREDENTIAL_BILLING_API_USERNAME";
const PASSWORD_VAR = "RELAY_CREDENTIAL_BILLING_API_PASSWORD";
const VALUE_VAR = "RELAY_CREDENTIAL_BILLING_API_VALUE";
const MUTUAL: RelayCredential = { name: "billing-api", scheme: "mutual_tls" };
const CERT_VAR = "RELAY_CREDENTIAL_BILLING_API_CERT";
const KEY_VAR = "RELAY_CREDENTIAL_BILLING_API_KEY";

function storeOf(entries: Record<string, string>): ReadonlyMap<string, string> {
  return new Map(Object.entries(entries));
}

/** The headers of an outcome the test expects to succeed. */
function headersOf(outcome: CredentialOutcome): HeaderEntry[] {
  if (!outcome.ok) throw new Error(`Expected headers, and the credential was refused: ${outcome.message}`);
  return outcome.headers;
}

/** The message of an outcome the test expects to fail. */
function messageOf(outcome: CredentialOutcome): string {
  if (outcome.ok) throw new Error("Expected the credential to be refused, and it was added.");
  return outcome.message;
}

describe("credentialEnvName", () => {
  it("names the variable after the credential, uppercase, with hyphens as underscores", () => {
    expect(credentialEnvName("billing-api", "TOKEN")).toBe(TOKEN_VAR);
    expect(credentialEnvName("a-b-c", "PASSWORD")).toBe("RELAY_CREDENTIAL_A_B_C_PASSWORD");
    expect(credentialEnvName("ledger2", "VALUE")).toBe("RELAY_CREDENTIAL_LEDGER2_VALUE");
    expect(credentialEnvName("billing-api", "USERNAME")).toBe(USERNAME_VAR);
    expect(credentialEnvName("billing-api", "CERT")).toBe(CERT_VAR);
    expect(credentialEnvName("billing-api", "KEY")).toBe(KEY_VAR);
  });
});

describe("addCredential", () => {
  it("leaves the headers alone when the envelope names no credential", () => {
    const headers: HeaderEntry[] = [["Authorization", "Bearer from-agent"]];
    const outcome = addCredential(headers, undefined, new Map(), "http");

    expect(outcome).toEqual({ ok: true, headers: [["Authorization", "Bearer from-agent"]] });
    expect(headersOf(outcome)).not.toBe(headers);
  });

  it("adds a bearer token as the authorization header", () => {
    const outcome = addCredential([["accept", "application/json"]], BEARER, storeOf({ [TOKEN_VAR]: "s3cret" }), "http");

    expect(outcome).toEqual({
      ok: true,
      headers: [
        ["accept", "application/json"],
        ["authorization", "Bearer s3cret"],
      ],
    });
  });

  it("adds a basic credential as base64 of user:password", () => {
    // The example pair from RFC 7617.
    const store = storeOf({ [USERNAME_VAR]: "Aladdin", [PASSWORD_VAR]: "open sesame" });

    expect(headersOf(addCredential([], BASIC, store, "http"))).toEqual([
      ["authorization", "Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ=="],
    ]);
  });

  it("allows a colon in a basic password", () => {
    const store = storeOf({ [USERNAME_VAR]: "Aladdin", [PASSWORD_VAR]: "open:sesame" });
    const [entry] = headersOf(addCredential([], BASIC, store, "http"));
    const encoded = entry?.[1].replace(/^Basic /, "") ?? "";

    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe("Aladdin:open:sesame");
  });

  it("refuses a colon in a basic user name, naming the variable and not the value", () => {
    const store = storeOf({ [USERNAME_VAR]: "Ala:ddin", [PASSWORD_VAR]: "open sesame" });
    const message = messageOf(addCredential([], BASIC, store, "http"));

    expect(message).toContain(`${USERNAME_VAR} holds a colon`);
    expect(message).not.toContain("Ala:ddin");
    expect(message).not.toContain("open sesame");
  });

  it("sends a header credential in the header the envelope names", () => {
    const outcome = addCredential([["accept", "*/*"]], HEADER, storeOf({ [VALUE_VAR]: "k-123" }), "http");

    expect(headersOf(outcome)).toEqual([
      ["accept", "*/*"],
      ["X-Api-Key", "k-123"],
    ]);
  });

  it("refuses a header credential that names no header", () => {
    const noHeader: RelayCredential = { name: "billing-api", scheme: "header" };
    const message = messageOf(addCredential([], noHeader, storeOf({ [VALUE_VAR]: "k-123" }), "http"));

    expect(message).toContain("billing-api");
    expect(message).toContain("names no header");
  });

  const unset: [string, Record<string, string>][] = [
    ["missing", {}],
    ["empty", { [TOKEN_VAR]: "" }],
  ];
  it.each(unset)("asks for the variable when it is %s", (_label, entries) => {
    const message = messageOf(addCredential([], BEARER, storeOf(entries), "http"));

    expect(message).toContain("Credential billing-api is not set up");
    expect(message).toContain(`Set ${TOKEN_VAR} in the relay's environment.`);
  });

  it("names every missing variable of a basic credential", () => {
    const message = messageOf(addCredential([], BASIC, new Map(), "http"));

    expect(message).toContain(`Set ${USERNAME_VAR}`);
    expect(message).toContain(`Set ${PASSWORD_VAR}`);
  });

  it.each([
    ["a CR", "\r"],
    ["an LF", "\n"],
    ["a NUL", "\0"],
    ["a DEL", "\u007f"],
    ["a character past U+00FF", "\u20ac"],
  ])("refuses an HTTP value that holds %s, naming the variable and not the value", (_label, character) => {
    const message = messageOf(addCredential([], BEARER, storeOf({ [TOKEN_VAR]: `s3cret${character}tail` }), "http"));

    expect(message).toContain(`${TOKEN_VAR} holds a character an HTTP header cannot carry.`);
    expect(message).not.toContain("s3cret");
  });

  it("accepts an HTTP value that holds a tab and a Latin-1 letter", () => {
    const outcome = addCredential([], BEARER, storeOf({ [TOKEN_VAR]: "caf\u00e9\ts3cret" }), "http");

    expect(outcome).toEqual({ ok: true, headers: [["authorization", "Bearer caf\u00e9\ts3cret"]] });
  });

  it.each([
    ["a tab", "\t"],
    ["a Latin-1 letter", "\u00e9"],
    ["a DEL", "\u007f"],
  ])("refuses a gRPC value that holds %s, naming the variable and not the value", (_label, character) => {
    const message = messageOf(addCredential([], BEARER, storeOf({ [TOKEN_VAR]: `s3cret${character}tail` }), "grpc"));

    expect(message).toContain(`${TOKEN_VAR} holds a character gRPC metadata cannot carry.`);
    expect(message).not.toContain("s3cret");
  });

  it("encodes a basic password that holds a character a header cannot carry", () => {
    const outcome = addCredential([], BASIC, storeOf({ [USERNAME_VAR]: "ops", [PASSWORD_VAR]: "p\u20ac\nss" }), "grpc");

    const encoded = Buffer.from("ops:p\u20ac\nss", "utf8").toString("base64");
    expect(outcome).toEqual({ ok: true, headers: [["authorization", `Basic ${encoded}`]] });
  });

  it("refuses a scheme this relay version does not know", () => {
    const digest = { name: "billing-api", scheme: "digest" } as unknown as RelayCredential;
    const message = messageOf(addCredential([], digest, storeOf({ [TOKEN_VAR]: "s3cret" }), "http"));

    expect(message).toContain("the digest scheme");
    expect(message).toContain("Update the relay.");
  });

  it("replaces a header of the same name whatever its case", () => {
    const headers: HeaderEntry[] = [
      ["Authorization", "Bearer from-agent"],
      ["accept", "application/json"],
      ["AUTHORIZATION", "Basic also-from-agent"],
    ];
    const outcome = addCredential(headers, BEARER, storeOf({ [TOKEN_VAR]: "s3cret" }), "http");

    expect(headersOf(outcome)).toEqual([
      ["accept", "application/json"],
      ["authorization", "Bearer s3cret"],
    ]);
    // The caller's list is not changed.
    expect(headers).toHaveLength(3);
  });

  it("keeps the header name's case for HTTP when it replaces a header", () => {
    const outcome = addCredential([["x-api-key", "from-agent"]], HEADER, storeOf({ [VALUE_VAR]: "k-123" }), "http");

    expect(headersOf(outcome)).toEqual([["X-Api-Key", "k-123"]]);
  });

  it("lowercases the header name for gRPC metadata and replaces any case of it", () => {
    const metadata: HeaderEntry[] = [
      ["X-API-KEY", "from-agent"],
      ["x-trace-id", "t-1"],
    ];
    const outcome = addCredential(metadata, HEADER, storeOf({ [VALUE_VAR]: "k-123" }), "grpc");

    expect(headersOf(outcome)).toEqual([
      ["x-trace-id", "t-1"],
      ["x-api-key", "k-123"],
    ]);
  });

  it("leaves gRPC metadata alone when the envelope names no credential", () => {
    expect(addCredential([["X-Trace-Id", "t-1"]], undefined, new Map(), "grpc")).toEqual({
      ok: true,
      headers: [["X-Trace-Id", "t-1"]],
    });
  });
});

describe("addCredential with a mutual_tls credential", () => {
  const pair = testCertificate();

  it("adds no header and hands back the certificate and key", () => {
    const headers: HeaderEntry[] = [["accept", "application/json"]];
    const outcome = addCredential(headers, MUTUAL, storeOf({ [CERT_VAR]: pair.cert, [KEY_VAR]: pair.key }), "http");

    expect(outcome).toEqual({
      ok: true,
      headers: [["accept", "application/json"]],
      clientCert: { name: "billing-api", cert: pair.cert, key: pair.key },
    });
    expect(headersOf(outcome)).not.toBe(headers);
  });

  it("reads a certificate and key written on one line with escaped line breaks", () => {
    const store = storeOf({ [CERT_VAR]: pair.cert.replace(/\n/g, "\\n"), [KEY_VAR]: pair.key.replace(/\n/g, "\\n") });
    const outcome = addCredential([], MUTUAL, store, "grpc");

    expect(outcome).toEqual({ ok: true, headers: [], clientCert: { name: "billing-api", cert: pair.cert, key: pair.key } });
  });

  it("names each missing variable", () => {
    expect(messageOf(addCredential([], MUTUAL, storeOf({ [KEY_VAR]: pair.key }), "http"))).toBe(
      `Credential billing-api is not set up: Set ${CERT_VAR} in the relay's environment.`,
    );
    expect(messageOf(addCredential([], MUTUAL, storeOf({ [CERT_VAR]: pair.cert }), "http"))).toBe(
      `Credential billing-api is not set up: Set ${KEY_VAR} in the relay's environment.`,
    );
    expect(messageOf(addCredential([], MUTUAL, new Map(), "http"))).toBe(
      `Credential billing-api is not set up: Set ${CERT_VAR} in the relay's environment. Set ${KEY_VAR} in the relay's environment.`,
    );
  });

  it("refuses a value that is not a certificate, naming the variable and not the value", () => {
    const message = messageOf(
      addCredential([], MUTUAL, storeOf({ [CERT_VAR]: "not-a-cert-s3cret", [KEY_VAR]: pair.key }), "http"),
    );

    expect(message).toBe(`Credential billing-api is not set up: ${CERT_VAR} does not hold a PEM certificate.`);
    expect(message).not.toContain("s3cret");
  });

  it("refuses a value that is not a private key, naming the variable and not the value", () => {
    const message = messageOf(
      addCredential([], MUTUAL, storeOf({ [CERT_VAR]: pair.cert, [KEY_VAR]: "not-a-key-s3cret" }), "http"),
    );

    expect(message).toBe(`Credential billing-api is not set up: ${KEY_VAR} does not hold an unencrypted PEM private key.`);
    expect(message).not.toContain("s3cret");
  });

  it("refuses a key that does not match the certificate", () => {
    const other = testCertificate("another");
    const message = messageOf(addCredential([], MUTUAL, storeOf({ [CERT_VAR]: pair.cert, [KEY_VAR]: other.key }), "http"));

    expect(message).toBe(
      `Credential billing-api is not set up: ${KEY_VAR} holds a key that does not match the certificate in ${CERT_VAR}.`,
    );
  });
});
