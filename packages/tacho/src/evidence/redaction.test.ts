import { describe, expect, it } from "vitest";
import { digestBytes } from "../digest";
import { contentFrameOf, redactBytes, redactionMarker } from "./redaction";

const enc = new TextEncoder();
const dec = new TextDecoder();
const text = (bytes: Uint8Array) => dec.decode(bytes);

describe("redactBytes", () => {
  it("leaves a body with no credential untouched", () => {
    const input = enc.encode('{"role":"user","content":"deploy the fix"}');
    const out = redactBytes(input);
    expect(out.bytes).toBe(input);
    expect(out.redactions).toEqual([]);
  });

  it("replaces a model API key and records the span and digest", () => {
    const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const out = redactBytes(enc.encode(`key=${key} rest`));
    expect(text(out.bytes)).toBe(
      `key=${redactionMarker("model_api_key")} rest`,
    );
    expect(out.redactions).toEqual([
      {
        path: `bytes:4-${4 + key.length}`,
        reason: "model_api_key",
        original_digest: digestBytes(key),
      },
    ]);
  });

  it("redacts a private key block across lines", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nAAAA\n-----END RSA PRIVATE KEY-----";
    const out = redactBytes(enc.encode(`before\n${pem}\nafter`));
    expect(text(out.bytes)).toBe(
      `before\n${redactionMarker("private_key")}\nafter`,
    );
    expect(out.redactions[0]?.reason).toBe("private_key");
  });

  it("keeps the Bearer scheme and removes only the token", () => {
    const token = "abcdefghijklmnopqrstuvwxyz012345";
    const out = redactBytes(enc.encode(`Authorization: Bearer ${token}`));
    expect(text(out.bytes)).toBe(
      `Authorization: Bearer ${redactionMarker("bearer_token")}`,
    );
    expect(out.redactions[0]?.original_digest).toBe(digestBytes(token));
  });

  it("redacts a JWT inside a bearer header once", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop";
    const out = redactBytes(enc.encode(`Bearer ${jwt}`));
    expect(out.redactions).toHaveLength(1);
    expect(text(out.bytes)).not.toContain("eyJ");
  });

  it("reports byte offsets, not code-unit offsets, in the path", () => {
    const key = "AKIAABCDEFGHIJKLMNOP";
    const prefix = "héllo ";
    const out = redactBytes(enc.encode(`${prefix}${key}`));
    const byteStart = enc.encode(prefix).length;
    expect(out.redactions[0]?.path).toBe(
      `bytes:${byteStart}-${byteStart + key.length}`,
    );
  });

  it.each([
    ["aws_access_key", "AKIAABCDEFGHIJKLMNOP"],
    ["github_token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD"],
    ["github_token", "github_pat_11ABCDEFG0123456789abcdefgh"],
    ["slack_token", "xoxb-1234567890-abcdefghij"],
  ] as const)("recognises a %s", (reason, secret) => {
    const out = redactBytes(enc.encode(`x ${secret} y`));
    expect(out.redactions.map((r) => r.reason)).toEqual([reason]);
    expect(text(out.bytes)).toBe(`x ${redactionMarker(reason)} y`);
  });

  it("passes binary bytes through unchanged", () => {
    const input = new Uint8Array([0xff, 0xfe, 0x41, 0x4b, 0x49, 0x41]);
    const out = redactBytes(input);
    expect(out.bytes).toBe(input);
    expect(out.redactions).toEqual([]);
  });
});

describe("contentFrameOf", () => {
  it("digests what is left after redaction, not what arrived", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD";
    const frame = contentFrameOf(`deploy with ${secret} please`);

    // The bytes a body would ship carry no credential, and the chained
    // digest is over exactly those bytes. The control plane checks both,
    // so a digest taken before redaction could never be satisfied.
    expect(text(frame.bytes)).toBe(
      `deploy with ${redactionMarker("github_token")} please`,
    );
    expect(frame.digest).toBe(digestBytes(frame.bytes));
    expect(redactBytes(frame.bytes).redactions).toEqual([]);
    expect(frame.redactions.map((r) => r.reason)).toEqual(["github_token"]);
  });

  it("leaves clean content byte for byte, and records no redaction", () => {
    const frame = contentFrameOf("summarise the release notes");
    expect(text(frame.bytes)).toBe("summarise the release notes");
    expect(frame.digest).toBe(digestBytes("summarise the release notes"));
    expect(frame.redactions).toEqual([]);
  });
});
