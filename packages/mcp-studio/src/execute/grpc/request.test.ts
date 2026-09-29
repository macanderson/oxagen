// request.ts: the target and the call metadata of one gRPC call.
import { describe, expect, it } from "vitest";
import type { ManifestAuth } from "../../contract/manifest";
import { buildCredentials, buildTarget, RequestError } from "./request";
import { API_KEY_AUTH } from "./__tests__/ledger-context";

const METHOD = "a_intel.ledger.v1.Ledger/GetEntry";

function targetError(url: string | undefined): RequestError {
  try {
    buildTarget(url, METHOD);
  } catch (error) {
    if (error instanceof RequestError) return error;
    throw error;
  }
  throw new Error(`buildTarget accepted ${String(url)}.`);
}

function credentialError(run: () => unknown): RequestError {
  try {
    run();
  } catch (error) {
    if (error instanceof RequestError) return error;
    throw error;
  }
  throw new Error("buildCredentials accepted the credential.");
}

describe("buildTarget", () => {
  it("splits the method into the service and the method name", () => {
    expect(buildTarget("https://ledger.example.com", METHOD)).toEqual({
      kind: "grpc",
      scheme: "https",
      host: "ledger.example.com",
      service: "a_intel.ledger.v1.Ledger",
      method: "GetEntry",
    });
  });

  it("omits the scheme's default port and keeps any other", () => {
    expect(buildTarget("https://ledger.example.com:443", METHOD).port).toBeUndefined();
    expect(buildTarget("http://127.0.0.1:50051", METHOD)).toMatchObject({
      scheme: "http",
      host: "127.0.0.1",
      port: 50051,
    });
  });

  it("writes the host in lowercase", () => {
    expect(buildTarget("https://Ledger.Example.COM", METHOD).host).toBe("ledger.example.com");
  });

  it("refuses an environment with no url", () => {
    const error = targetError(undefined);
    expect(error.title).toBe("Invalid environment");
    expect(error.message).toBe("The environment has no url, so the call has no host.");
  });

  it("refuses a url that does not parse", () => {
    expect(targetError("ledger").message).toBe("The environment url ledger does not parse.");
  });

  it("refuses a scheme other than https and http", () => {
    expect(targetError("ftp://ledger.example.com").message).toBe(
      "A gRPC environment url is https or http, not ftp.",
    );
  });

  it.each([
    ["a path", "https://ledger.example.com/v1"],
    ["a query", "https://ledger.example.com/?region=us"],
    ["a fragment", "https://ledger.example.com/#top"],
    ["a user", "https://svc@ledger.example.com"],
    ["a password", "https://svc:secret@ledger.example.com"],
  ])("refuses a url with %s", (_, url) => {
    expect(targetError(url).message).toBe(
      `A gRPC environment url is a scheme, a host, and a port, with no path, query, or user: ${url}.`,
    );
  });

  it("refuses a host the relay envelope cannot carry", () => {
    const error = targetError("https://[::1]:8443");
    expect(error.title).toBe("Invalid environment");
    expect(error.message).toMatch(/^The call target is not valid \(host: /);
  });
});

describe("buildCredentials", () => {
  it("sends nothing for no credential", () => {
    expect(buildCredentials(null, { type: "none" }, "cloud")).toEqual({ metadata: [], relay_credential: undefined });
  });

  it("sends a bearer token as authorization metadata", () => {
    expect(buildCredentials(null, { type: "bearer", token: "tok_1" }, "cloud").metadata).toEqual([
      ["authorization", "Bearer tok_1"],
    ]);
  });

  it("sends basic credentials as authorization metadata", () => {
    const pair = Buffer.from("svc:pa ss", "utf8").toString("base64");
    expect(buildCredentials(null, { type: "basic", username: "svc", password: "pa ss" }, "cloud").metadata).toEqual([
      ["authorization", `Basic ${pair}`],
    ]);
  });

  it("sends an API key in the scheme's header, in lowercase", () => {
    expect(buildCredentials(API_KEY_AUTH, { type: "api_key", value: "key_1" }, "cloud").metadata).toEqual([
      ["x-api-key", "key_1"],
    ]);
  });

  it("hands a relay credential to the relay and sends no metadata", () => {
    const credential = { name: "ledger_key", scheme: "bearer" as const };
    expect(buildCredentials(null, { type: "relay", credential }, "relay:acme")).toEqual({
      metadata: [],
      relay_credential: credential,
    });
  });

  it("refuses a relay credential off a relay network", () => {
    const credential = { name: "ledger_key", scheme: "bearer" as const };
    const error = credentialError(() => buildCredentials(null, { type: "relay", credential }, "cloud"));
    expect(error.title).toBe("Invalid credential");
    expect(error.message).toBe("A relay credential needs a relay network, but this environment's network is cloud.");
  });

  it("refuses an API key with no api_key scheme", () => {
    const bearer: ManifestAuth = { mode: "service", scheme: "token", apply: { type: "http_bearer" } };
    for (const auth of [null, bearer]) {
      expect(credentialError(() => buildCredentials(auth, { type: "api_key", value: "key_1" }, "cloud")).message).toBe(
        "An API key needs an api_key auth scheme with a header name.",
      );
    }
  });

  it("refuses an API key the scheme puts in a query or a cookie", () => {
    for (const where of ["query", "cookie"] as const) {
      const auth: ManifestAuth = { ...API_KEY_AUTH, apply: { type: "api_key", in: where, name: "key" } };
      expect(credentialError(() => buildCredentials(auth, { type: "api_key", value: "key_1" }, "cloud")).message).toBe(
        `A gRPC call has no ${where} to carry an API key. Set the scheme's key in a header.`,
      );
    }
  });

  it.each(["X-Key-Bin", "grpc-timeout", "x key", "x/key"])("refuses %s as a metadata name", (name) => {
    const auth: ManifestAuth = { ...API_KEY_AUTH, apply: { type: "api_key", in: "header", name } };
    const error = credentialError(() => buildCredentials(auth, { type: "api_key", value: "key_1" }, "cloud"));
    expect(error.title).toBe("Invalid credential");
    expect(error.message).toMatch(/cannot carry a credential in gRPC metadata/);
  });

  it("refuses a value gRPC metadata cannot carry", () => {
    const error = credentialError(() => buildCredentials(null, { type: "bearer", token: "tok\n1" }, "cloud"));
    expect(error.message).toBe(
      "The credential for authorization has characters gRPC metadata cannot carry. Store it as printable ASCII.",
    );
  });
});

describe("buildCredentials for mutual TLS", () => {
  const mtls: ManifestAuth = { mode: "service", scheme: "mtls", apply: { type: "mutual_tls" } };
  const certificate = { name: "ledger-cert", scheme: "mutual_tls" as const };

  it("hands the relay its client certificate and sends no metadata", () => {
    expect(buildCredentials(mtls, { type: "relay", credential: certificate }, "relay:acme")).toEqual({
      metadata: [],
      relay_credential: certificate,
    });
  });

  it("refuses a bearer token for a mutual TLS server", () => {
    const error = credentialError(() => buildCredentials(mtls, { type: "bearer", token: "tok_1" }, "relay:acme"));
    expect(error.title).toBe("Invalid credential");
    expect(error.message).toBe(
      "A mutual TLS server needs a client certificate that a relay holds, and this call's credential is not one.",
    );
  });

  it("refuses a client certificate for a server that is not mutual TLS", () => {
    const error = credentialError(() =>
      buildCredentials(API_KEY_AUTH, { type: "relay", credential: certificate }, "relay:acme"),
    );
    expect(error.title).toBe("Invalid credential");
    expect(error.message).toBe(
      "A relay's client certificate fits only a mutual TLS server, and this server's scheme is api_key.",
    );
  });
});
