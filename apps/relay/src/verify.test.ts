// verify.test.ts: each refusal verifyRequest gives, in the order it checks, and the request it accepts.
import { generateKeyPairSync } from "node:crypto";
import type { RelayEnvelope } from "@oxagen/mcp-studio";
import { toBase64, type RelayRefusalCode } from "@oxagen/relay-broker/protocol";
import { describe, expect, it } from "vitest";
import type { HeaderEntry } from "./credentials";
import { NonceCache } from "./nonces";
import {
  GRPC_TARGET,
  HTTP_TARGET,
  NOW,
  newNonce,
  requestFrame,
  signEnvelope,
  testConfig,
  testKey,
  unsignedEnvelope,
  type EnvelopeSpec,
  type EnvelopeTarget,
  type TestKey,
} from "./test/fixtures";
import {
  DEFAULT_DEADLINE_MS,
  verifyRequest,
  type Accepted,
  type Refused,
  type RequestFrame,
  type VerifySettings,
} from "./verify";

const key = testKey();
/** The relay process started a minute before NOW, so an envelope issued at NOW is new to it. */
const STARTED_AT = NOW - 60_000;
/** Trusts `key`, allows ledger.internal:50051 and billing.internal at its default port, and allows no clock skew. */
const config = testConfig(key);
/** The same settings with a five-second clock skew, the relay's default. */
const skewed = testConfig(key, { clockSkewMs: 5_000 });
/** A well-formed workspace id that is not the relay's own. */
const OTHER_WORKSPACE = "wrk_zyxwvtsrqpnmkjhgfedcba";
const encoder = new TextEncoder();

type HttpTarget = Extract<EnvelopeTarget, { kind: "http" }>;
type GrpcTarget = Extract<EnvelopeTarget, { kind: "grpc" }>;

/** HTTP_TARGET (POST https billing.internal /v1/invoices?limit=5, no port) with some fields changed. */
function httpTarget(overrides: Partial<Omit<HttpTarget, "kind">> = {}): HttpTarget {
  if (HTTP_TARGET.kind !== "http") throw new Error("HTTP_TARGET is not an HTTP target.");
  return { ...HTTP_TARGET, ...overrides };
}

/** GRPC_TARGET (http ledger.internal:50051) with some fields changed. */
function grpcTarget(overrides: Partial<Omit<GrpcTarget, "kind">> = {}): GrpcTarget {
  if (GRPC_TARGET.kind !== "grpc") throw new Error("GRPC_TARGET is not a gRPC target.");
  return { ...GRPC_TARGET, ...overrides };
}

/** The gRPC target with no port field, as the gateway writes it for the scheme's default port. */
function withoutPort(target: GrpcTarget): GrpcTarget {
  const { port: _port, ...rest } = target;
  return rest;
}

interface CheckOptions {
  config?: VerifySettings;
  nonces?: NonceCache;
  startedAt?: number;
  now?: number;
}

/** verifyRequest with the test settings, a fresh nonce cache, and the clock at NOW, unless the options say otherwise. */
function check(frame: RequestFrame, options: CheckOptions = {}): Accepted | Refused {
  return verifyRequest(frame, {
    config: options.config ?? config,
    nonces: options.nonces ?? new NonceCache(),
    startedAt: options.startedAt ?? STARTED_AT,
    now: options.now ?? NOW,
  });
}

function expectRefused(result: Accepted | Refused, code: RelayRefusalCode): Refused {
  expect(result).toMatchObject({ ok: false, code });
  if (result.ok) throw new Error(`Expected the refusal ${code}, and the request was accepted.`);
  return result;
}

function expectAccepted(result: Accepted | Refused): Accepted {
  if (!result.ok) throw new Error(`Expected the request to be accepted, and it was refused as ${result.code}: ${result.message}`);
  return result;
}

/** An envelope signed over the spec, by `key` unless another signer is named. */
function signed(spec: EnvelopeSpec = {}, signer: TestKey = key): RelayEnvelope {
  return signEnvelope(unsignedEnvelope(spec), signer);
}

/** A request frame around any envelope value, with no headers and an empty body. */
function frameOf(envelope: unknown): RequestFrame {
  return { type: "request", id: "call-1", envelope, headers: [], body: "" };
}

/**
 * A frame whose envelope was signed over the spec and then changed. The frame
 * carries no headers and no body, so the spec must name none.
 */
function edited(change: (raw: Record<string, unknown>) => void, spec: EnvelopeSpec = {}): RequestFrame {
  const raw: Record<string, unknown> = { ...signed(spec) };
  change(raw);
  return frameOf(raw);
}

describe("verifyRequest", () => {
  describe("invalid envelopes", () => {
    it.each<[string, unknown]>([
      ["null", null],
      ["a string", "relay-envelope/v1"],
      ["an array", [signed()]],
      ["a number", 42],
    ])("refuses an envelope that is %s as invalid", (_label, envelope) => {
      expectRefused(check(frameOf(envelope)), "invalid");
    });

    it("refuses an envelope with a missing field and names the field", () => {
      const frame = edited((raw) => {
        delete raw.nonce;
      });
      const result = expectRefused(check(frame), "invalid");
      expect(result.message).toContain("nonce");
    });

    it("refuses an envelope with a field the schema does not name and names the field", () => {
      const frame = edited((raw) => {
        raw.priority = "high";
      });
      const result = expectRefused(check(frame), "invalid");
      expect(result.message).toMatch(/the envelope: .*priority/);
    });

    it("refuses an envelope whose nonce is too short", () => {
      const frame = edited((raw) => {
        raw.nonce = "abc123";
      });
      expectRefused(check(frame), "invalid");
    });

    it("refuses a signature of the wrong shape as invalid, before it checks the signature", () => {
      const frame = edited((raw) => {
        raw.signature = { key_id: key.keyId, alg: "ed25519", sig: "c2lnbmF0dXJl" };
      });
      expectRefused(check(frame), "invalid");
    });

    it("refuses an envelope that expires more than 30 seconds after it was issued", () => {
      expectRefused(check(requestFrame(key, { ttlMs: 30_001 })), "invalid");
    });

    it("accepts an envelope that expires exactly 30 seconds after it was issued", () => {
      expectAccepted(check(requestFrame(key, { ttlMs: 30_000 })));
    });

    it("refuses an envelope that expires at the moment it was issued", () => {
      expectRefused(check(requestFrame(key, { ttlMs: 0 })), "invalid");
    });
  });

  describe("unsigned envelopes", () => {
    it("refuses an envelope with no signature field", () => {
      const frame = edited((raw) => {
        delete raw.signature;
      });
      expectRefused(check(frame), "unsigned");
    });

    it("reports an empty object as unsigned, because it looks for the signature before the schema", () => {
      expectRefused(check(frameOf({})), "unsigned");
    });
  });

  describe("signing keys and signatures", () => {
    it("refuses an envelope signed with a key the relay does not trust, and names the key and the variable", () => {
      const stranger = testKey();
      const result = expectRefused(check(frameOf(signed({}, stranger))), "untrusted_key");
      expect(result.message).toContain(stranger.keyId);
      expect(result.message).toContain("RELAY_TRUSTED_KEYS");
    });

    it("refuses an envelope whose path changed after signing", () => {
      const frame = edited((raw) => {
        raw.target = httpTarget({ path: "/v1/invoices?limit=5000" });
      });
      expectRefused(check(frame), "bad_signature");
    });

    it("refuses a signature of the right shape over the wrong bytes", () => {
      const frame = edited((raw) => {
        raw.signature = { key_id: key.keyId, alg: "ed25519", sig: Buffer.alloc(64).toString("base64") };
      });
      expectRefused(check(frame), "bad_signature");
    });

    it("refuses an envelope that names the trusted key id and was signed by another key", () => {
      const forged = signed({}, testKey());
      const frame = frameOf({ ...forged, signature: { ...forged.signature, key_id: key.keyId } });
      expectRefused(check(frame), "bad_signature");
    });

    it("refuses as bad_signature, without throwing, when the trusted key is not an ed25519 key", () => {
      const { publicKey } = generateKeyPairSync("x25519");
      const wrongKeyType = testConfig(key, { trustedKeys: new Map([[key.keyId, publicKey]]) });
      expectRefused(check(requestFrame(key), { config: wrongKeyType }), "bad_signature");
    });

    it("accepts an envelope whose fields arrive in another order, because the signature covers the canonical bytes", () => {
      const reordered: Record<string, unknown> = Object.fromEntries(Object.entries(signed()).reverse());
      expectAccepted(check(frameOf(reordered)));
    });

    it("checks the signature before the relay name, so a changed envelope for another relay reads bad_signature", () => {
      const frame = edited(
        (raw) => {
          raw.target = httpTarget({ method: "DELETE" });
        },
        { relay: "warehouse" },
      );
      expectRefused(check(frame), "bad_signature");
    });
  });

  describe("relay and workspace", () => {
    it("refuses an envelope for another relay", () => {
      expectRefused(check(requestFrame(key, { relay: "warehouse" })), "wrong_relay");
    });

    it("refuses an envelope for another workspace", () => {
      expectRefused(check(requestFrame(key, { workspace: OTHER_WORKSPACE })), "wrong_workspace");
    });

    it("reports the relay before the workspace when both are wrong", () => {
      expectRefused(check(requestFrame(key, { relay: "warehouse", workspace: OTHER_WORKSPACE })), "wrong_relay");
    });
  });

  describe("the time window", () => {
    it("refuses an envelope issued later than the relay's clock when no skew is allowed", () => {
      expectRefused(check(requestFrame(key, { issuedAt: NOW + 1 })), "not_yet_valid");
    });

    it("accepts an envelope issued as far ahead of the relay's clock as the skew allows", () => {
      expectAccepted(check(requestFrame(key, { issuedAt: NOW + 5_000 }), { config: skewed }));
    });

    it("refuses an envelope issued further ahead of the relay's clock than the skew allows", () => {
      expectRefused(check(requestFrame(key, { issuedAt: NOW + 5_001 }), { config: skewed }), "not_yet_valid");
    });

    it("accepts an envelope one millisecond before it expires", () => {
      expectAccepted(check(requestFrame(key), { now: NOW + 9_999 }));
    });

    it("refuses an envelope at the moment it expires", () => {
      expectRefused(check(requestFrame(key), { now: NOW + 10_000 }), "expired");
    });

    it("refuses an envelope after it expires", () => {
      expectRefused(check(requestFrame(key), { now: NOW + 60_000 }), "expired");
    });

    it("accepts an envelope within the skew after it expires", () => {
      expectAccepted(check(requestFrame(key), { config: skewed, now: NOW + 14_999 }));
    });

    it("refuses an envelope once the skew after its expiry has passed", () => {
      expectRefused(check(requestFrame(key), { config: skewed, now: NOW + 15_000 }), "expired");
    });

    it("refuses as expired an envelope issued before this relay process started, even though its window is open", () => {
      const frame = requestFrame(key, { issuedAt: NOW - 2_000 });
      const result = expectRefused(check(frame, { startedAt: NOW - 1_000 }), "expired");
      // The code is shared with the window check. The message tells the two causes apart.
      expect(result.message).toMatch(/process started/);
    });

    it("accepts an envelope issued at the moment the process started", () => {
      expectAccepted(check(requestFrame(key), { startedAt: NOW }));
    });

    it("refuses an envelope issued less than the skew after the process started", () => {
      const result = expectRefused(check(requestFrame(key), { config: skewed, startedAt: NOW - 4_999 }), "expired");
      expect(result.message).toMatch(/process started/);
    });

    it("accepts an envelope issued a full skew after the process started", () => {
      expectAccepted(check(requestFrame(key), { config: skewed, startedAt: NOW - 5_000 }));
    });
  });

  describe("nonces", () => {
    it("refuses the same frame the second time as replayed", () => {
      const nonces = new NonceCache();
      const frame = requestFrame(key);
      expectAccepted(check(frame, { nonces }));
      expectRefused(check(frame, { nonces }), "replayed");
    });

    it("refuses a different envelope that reuses an accepted nonce", () => {
      const nonces = new NonceCache();
      const nonce = newNonce();
      expectAccepted(check(requestFrame(key, { nonce }), { nonces }));
      const second = requestFrame(key, { nonce, target: httpTarget({ path: "/v1/refunds" }) });
      expectRefused(check(second, { nonces }), "replayed");
    });

    interface Attempt {
      frame: RequestFrame;
      now?: number;
      startedAt?: number;
    }

    const refusedBeforeTheClaim: [string, RelayRefusalCode, (nonce: string) => Attempt][] = [
      ["untrusted_key", "untrusted_key", (nonce) => ({ frame: frameOf(signed({ nonce }, testKey())) })],
      [
        "bad_signature",
        "bad_signature",
        (nonce) => ({
          frame: edited(
            (raw) => {
              raw.target = httpTarget({ path: "/v1/refunds" });
            },
            { nonce },
          ),
        }),
      ],
      ["wrong_relay", "wrong_relay", (nonce) => ({ frame: requestFrame(key, { nonce, relay: "warehouse" }) })],
      ["wrong_workspace", "wrong_workspace", (nonce) => ({ frame: requestFrame(key, { nonce, workspace: OTHER_WORKSPACE }) })],
      ["not_yet_valid", "not_yet_valid", (nonce) => ({ frame: requestFrame(key, { nonce, issuedAt: NOW + 1_000 }) })],
      ["expired", "expired", (nonce) => ({ frame: requestFrame(key, { nonce }), now: NOW + 10_000 })],
      [
        "expired because it predates the process",
        "expired",
        (nonce) => ({ frame: requestFrame(key, { nonce, issuedAt: NOW - 2_000 }), startedAt: NOW - 1_000 }),
      ],
    ];

    it.each(refusedBeforeTheClaim)(
      "leaves the nonce unused when it refuses an envelope as %s, so a valid envelope with that nonce is accepted",
      (_label, code, attempt) => {
        const nonces = new NonceCache();
        const nonce = newNonce();
        const { frame, now, startedAt } = attempt(nonce);
        expectRefused(check(frame, { nonces, now, startedAt }), code);
        expect(nonces.size).toBe(0);
        expectAccepted(check(requestFrame(key, { nonce }), { nonces }));
      },
    );

    it("uses up the nonce of an envelope refused after the claim, so the corrected frame reads replayed", () => {
      const nonces = new NonceCache();
      const frame = requestFrame(key, { headers: [["x-request-id", "req-1"]] });
      expectRefused(check({ ...frame, headers: [["x-request-id", "req-2"]] }, { nonces }), "headers_mismatch");
      expect(nonces.size).toBe(1);
      expectRefused(check(frame, { nonces }), "replayed");
    });

    it("refuses as busy when the nonce cache is full of live nonces, and says to try again", () => {
      const nonces = new NonceCache(1);
      expectAccepted(check(requestFrame(key), { nonces }));
      const result = expectRefused(check(requestFrame(key), { nonces }), "busy");
      expect(result.message).toContain("Try again");
    });
  });

  describe("headers and body against their hashes", () => {
    const signedHeaders: HeaderEntry[] = [
      ["content-type", "application/json"],
      ["x-request-id", "req-1"],
    ];

    it.each<[string, HeaderEntry[]]>([
      [
        "a changed value",
        [
          ["content-type", "application/json"],
          ["x-request-id", "req-2"],
        ],
      ],
      [
        "a value whose case alone changed",
        [
          ["content-type", "Application/JSON"],
          ["x-request-id", "req-1"],
        ],
      ],
      [
        "the same pairs in another order",
        [
          ["x-request-id", "req-1"],
          ["content-type", "application/json"],
        ],
      ],
      [
        "an extra header",
        [
          ["content-type", "application/json"],
          ["x-request-id", "req-1"],
          ["x-extra", "1"],
        ],
      ],
      ["a missing header", [["content-type", "application/json"]]],
    ])("refuses a frame whose headers differ from the signed ones by %s", (_label, sent) => {
      const frame = requestFrame(key, { headers: signedHeaders });
      expectRefused(check({ ...frame, headers: sent }), "headers_mismatch");
    });

    it("accepts a header name whose case alone differs, because names hash in lowercase, and keeps the name as sent", () => {
      const frame = requestFrame(key, { headers: signedHeaders });
      const sent: HeaderEntry[] = [
        ["Content-Type", "application/json"],
        ["X-Request-Id", "req-1"],
      ];
      const result = expectAccepted(check({ ...frame, headers: sent }));
      expect(result.headers).toEqual(sent);
    });

    it("refuses a frame whose body differs from the signed body", () => {
      const frame = requestFrame(key, { body: '{"amount":5}' });
      expectRefused(check({ ...frame, body: toBase64(encoder.encode('{"amount":500}')) }), "body_mismatch");
    });

    it("refuses a frame that drops the signed body", () => {
      const frame = requestFrame(key, { body: '{"amount":5}' });
      expectRefused(check({ ...frame, body: "" }), "body_mismatch");
    });
  });

  describe("HTTP header rules", () => {
    /** A frame signed over the same headers it carries, so the hash check passes and the header rules decide. */
    function httpFrame(headers: HeaderEntry[], body = ""): RequestFrame {
      return requestFrame(key, { headers, body });
    }

    it.each(["x request-id", "x:request-id", "x-request-idé", "x(1)", ""])(
      "refuses the header name %j, which is not an HTTP token",
      (name) => {
        expectRefused(check(httpFrame([[name, "1"]])), "invalid");
      },
    );

    it.each<[string, string]>([
      ["a carriage return", "a\rb"],
      ["a line feed", "a\nb"],
      ["a NUL", "a\u0000b"],
      ["a start-of-heading control character", "a\u0001b"],
      ["a DEL", "a\u007fb"],
      ["a character past U+00FF", "a€b"],
    ])("refuses a header value that holds %s", (_label, value) => {
      const refused = expectRefused(check(httpFrame([["x-note", value]])), "invalid");
      expect(refused.message).toMatch(/cannot carry/);
    });

    it("accepts a header value that holds a tab and a Latin-1 letter", () => {
      expectAccepted(check(httpFrame([["x-note", "café\tlatte"]])));
    });

    it.each(["host", "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"])(
      "refuses a request that carries the %s header, which the relay sets itself",
      (name) => {
        expectRefused(check(httpFrame([[name, "x"]])), "invalid");
      },
    );

    it("refuses a connection header written in mixed case", () => {
      expectRefused(check(httpFrame([["Transfer-Encoding", "chunked"]])), "invalid");
    });

    // "héllo" is five characters and six bytes in UTF-8.
    const multibyteBody = "héllo";

    it("refuses a content-length that counts characters instead of bytes, and gives both numbers", () => {
      const result = expectRefused(check(httpFrame([["content-length", "5"]], multibyteBody)), "invalid");
      expect(result.message).toContain("says 5");
      expect(result.message).toContain("6 bytes");
    });

    it("accepts a content-length that matches the body's length in bytes", () => {
      expectAccepted(check(httpFrame([["Content-Length", "6"]], multibyteBody)));
    });
  });

  describe("gRPC metadata rules", () => {
    /** A gRPC frame signed over the same metadata it carries, so the hash check passes and the metadata rules decide. */
    function grpcFrame(metadata: HeaderEntry[]): RequestFrame {
      return requestFrame(key, { target: GRPC_TARGET, headers: metadata, body: new Uint8Array([0x0a, 0x01, 0x41]) });
    }

    it.each(["x/trace", "x trace", "x:trace", "traceé"])("refuses the metadata name %j, which gRPC does not allow", (name) => {
      expectRefused(check(grpcFrame([[name, "1"]])), "invalid");
    });

    it.each(["grpc-timeout", "GRPC-Timeout"])("refuses the metadata name %s, which gRPC reserves", (name) => {
      expectRefused(check(grpcFrame([[name, "1S"]])), "invalid");
    });

    it("refuses a -bin metadata value that is not base64", () => {
      expectRefused(check(grpcFrame([["trace-bin", "not base64!"]])), "invalid");
    });

    it.each<[string, string]>([
      ["a tab", "a\tb"],
      ["a line feed", "a\nb"],
      ["a DEL", "a\u007fb"],
      ["a character outside ASCII", "café"],
    ])("refuses a text metadata value that holds %s", (_label, value) => {
      expectRefused(check(grpcFrame([["x-note", value]])), "invalid");
    });

    it("accepts an uppercase metadata name, because it checks the name in lowercase", () => {
      expectAccepted(check(grpcFrame([["X-Trace-Id", "t-1"]])));
    });
  });

  describe("the host allowlist", () => {
    it("refuses a host the allowlist does not name, and names the host and port to add", () => {
      const frame = requestFrame(key, { target: httpTarget({ host: "payroll.internal" }) });
      const result = expectRefused(check(frame), "host_not_allowed");
      expect(result.message).toContain("RELAY_ALLOWED_HOSTS");
      expect(result.message).toContain("payroll.internal:443");
    });

    it.each<[string, EnvelopeTarget]>([
      ["an exact host at another port", grpcTarget({ port: 50052 })],
      ["an exact host at its scheme's default port", withoutPort(grpcTarget())],
      ["a default-port host at a port it does not default to", httpTarget({ port: 8443 })],
      ["a default-port host over https at port 80", httpTarget({ port: 80 })],
    ])("refuses %s", (_label, target) => {
      expectRefused(check(requestFrame(key, { target })), "host_not_allowed");
    });

    it.each<[string, EnvelopeTarget]>([
      ["https with the port left out", httpTarget()],
      ["https with port 443 written out", httpTarget({ port: 443 })],
      ["http with the port left out", httpTarget({ scheme: "http" })],
      ["http with port 80 written out", httpTarget({ scheme: "http", port: 80 })],
    ])("accepts a default-port host over %s", (_label, target) => {
      expectAccepted(check(requestFrame(key, { target })));
    });
  });

  describe("credentials", () => {
    it("refuses an envelope that names a credential the relay's environment does not hold, and names the variable to set", () => {
      const frame = requestFrame(key, { credential: { name: "billing-api", scheme: "bearer" } });
      const result = expectRefused(check(frame), "credential_missing");
      expect(result.message).toContain("RELAY_CREDENTIAL_BILLING_API_TOKEN");
    });

    it("refuses a credential whose variable is set to an empty value", () => {
      const emptyToken = testConfig(key, { credentials: new Map([["RELAY_CREDENTIAL_BILLING_API_TOKEN", ""]]) });
      const frame = requestFrame(key, { credential: { name: "billing-api", scheme: "bearer" } });
      expectRefused(check(frame, { config: emptyToken }), "credential_missing");
    });

    it.each<[string, Record<string, unknown>]>([
      ["an unknown scheme", { name: "billing-api", scheme: "digest" }],
      ["the header scheme with no header named", { name: "billing-api", scheme: "header" }],
    ])("refuses a credential with %s as invalid, because the schema refuses it before the credential step", (_label, credential) => {
      const frame = edited((raw) => {
        raw.credential = credential;
      });
      expectRefused(check(frame), "invalid");
    });

    // A value a test can look for in every refusal message, to show the secret stays out of it.
    const SECRET = "admin.billing.internal";
    const withValue = testConfig(key, { credentials: new Map([["RELAY_CREDENTIAL_BILLING_API_VALUE", SECRET]]) });

    it.each(["Host", "content-length", "Transfer-Encoding", "connection", "upgrade"])(
      "refuses an HTTP header credential that names %s as invalid, and never quotes the secret",
      (header) => {
        const frame = requestFrame(key, { credential: { name: "billing-api", scheme: "header", header } });
        const result = expectRefused(check(frame, { config: withValue }), "invalid");
        expect(result.message).toContain(`the ${header.toLowerCase()} header`);
        expect(result.message).not.toContain(SECRET);
      },
    );

    it.each(["grpc-timeout", "Grpc-Encoding", "trace-bin", "content-type", "te", "host", "x!key"])(
      "refuses a gRPC header credential that names %s as invalid, and never quotes the secret",
      (header) => {
        const frame = requestFrame(key, { target: GRPC_TARGET, credential: { name: "billing-api", scheme: "header", header } });
        const result = expectRefused(check(frame, { config: withValue }), "invalid");
        expect(result.message).toContain(`the ${header.toLowerCase()} header`);
        expect(result.message).not.toContain(SECRET);
      },
    );

    it("checks a credential's header before the host allowlist, as it checks the signed headers", () => {
      const frame = requestFrame(key, {
        target: httpTarget({ host: "elsewhere.internal" }),
        credential: { name: "billing-api", scheme: "header", header: "Host" },
      });
      expectRefused(check(frame, { config: withValue }), "invalid");
    });

    it.each<[string, EnvelopeTarget, string]>([
      ["an HTTP", HTTP_TARGET, "X-Api-Key"],
      ["a gRPC", GRPC_TARGET, "x-api-key"],
    ])("accepts a header credential on %s call that names an ordinary header, and adds it", (_label, target, name) => {
      const frame = requestFrame(key, { target, credential: { name: "billing-api", scheme: "header", header: "X-Api-Key" } });
      const result = expectAccepted(check(frame, { config: withValue }));
      expect(result.headers).toEqual([[name, SECRET]]);
    });
  });

  describe("accepted requests", () => {
    const withToken = testConfig(key, {
      credentials: new Map([["RELAY_CREDENTIAL_BILLING_API_TOKEN", "tok_live_123"]]),
    });

    it("returns the envelope, the headers as sent, the body bytes, and the default deadline", () => {
      const headers: HeaderEntry[] = [
        ["content-type", "application/json"],
        ["x-request-id", "req-1"],
      ];
      const body = '{"amount":5}';
      const frame = requestFrame(key, { headers, body });
      const result = expectAccepted(check(frame));
      expect(result.ok).toBe(true);
      expect(result.envelope).toEqual(frame.envelope);
      expect(result.headers).toEqual(headers);
      expect(new TextDecoder().decode(result.body)).toBe(body);
      expect(result.body.byteLength).toBe(12);
      expect(result.deadlineMs).toBe(DEFAULT_DEADLINE_MS);
    });

    it("waits 30 seconds by default, as the envelope schema documents for an omitted deadline_ms", () => {
      expect(DEFAULT_DEADLINE_MS).toBe(30_000);
    });

    it("returns the envelope's deadline_ms when it names one", () => {
      const result = expectAccepted(check(requestFrame(key, { deadlineMs: 2_500 })));
      expect(result.deadlineMs).toBe(2_500);
    });

    it("adds a bearer credential as an authorization header after the headers it checked", () => {
      const frame = requestFrame(key, {
        headers: [["x-request-id", "req-1"]],
        credential: { name: "billing-api", scheme: "bearer" },
      });
      const result = expectAccepted(check(frame, { config: withToken }));
      expect(result.headers).toEqual([
        ["x-request-id", "req-1"],
        ["authorization", "Bearer tok_live_123"],
      ]);
    });

    it("replaces an authorization header the frame carried with the relay's own credential", () => {
      const frame = requestFrame(key, {
        headers: [
          ["Authorization", "Bearer from-the-broker"],
          ["x-request-id", "req-1"],
        ],
        credential: { name: "billing-api", scheme: "bearer" },
      });
      const result = expectAccepted(check(frame, { config: withToken }));
      expect(result.headers).toEqual([
        ["x-request-id", "req-1"],
        ["authorization", "Bearer tok_live_123"],
      ]);
    });

    it("accepts a gRPC call with its metadata and message bytes", () => {
      const metadata: HeaderEntry[] = [
        ["x-trace-id", "t-1"],
        ["trace-bin", "AAEC"],
      ];
      const message = new Uint8Array([0x0a, 0x03, 0x61, 0x62, 0x63]);
      const frame = requestFrame(key, { target: GRPC_TARGET, headers: metadata, body: message });
      const result = expectAccepted(check(frame));
      expect(result.envelope.target).toEqual(GRPC_TARGET);
      expect(result.headers).toEqual(metadata);
      expect(Array.from(result.body)).toEqual(Array.from(message));
      expect(result.deadlineMs).toBe(DEFAULT_DEADLINE_MS);
    });
  });
});
