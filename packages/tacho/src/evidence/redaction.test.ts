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

describe("redactBytes on credential-heavy content", () => {
  it("keeps byte offsets right when the text is not all ASCII", () => {
    // The offsets are UTF-8 byte spans in the ORIGINAL text, and they are
    // now carried forward rather than recomputed. A multi-byte prefix is
    // where an off-by-some would show.
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD";
    const prefix = "naïve café ☕ ";
    const out = redactBytes(enc.encode(`${prefix}${secret} and ${secret}`));
    const prefixBytes = enc.encode(prefix).length;

    expect(out.redactions.map((r) => r.path)).toEqual([
      `bytes:${prefixBytes}-${prefixBytes + secret.length}`,
      `bytes:${prefixBytes + secret.length + 5}-${
        prefixBytes + secret.length + 5 + secret.length
      }`,
    ]);
  });

  it("stays linear in the number of matches", () => {
    // Re-encoding the whole prefix for every match made this quadratic, and
    // it runs on the blocking hook path for every turn. The loopback hook
    // endpoint accepts 8 MiB, and hook handling is serialised, so a pasted
    // token log would hold the daemon and every hook queued behind it. At
    // this size the old shape took 5.7s and this one takes about 0.13s; the
    // bound sits between, with room for a slow runner.
    const parts: string[] = [];
    for (let index = 0; index < 8_000; index += 1)
      parts.push(`${"x".repeat(200)} ghp_${String(index).padStart(36, "a")}`);
    const bytes = enc.encode(parts.join(" "));

    const startedAt = Date.now();
    const out = redactBytes(bytes);
    const elapsed = Date.now() - startedAt;

    expect(out.redactions).toHaveLength(8_000);
    expect(text(out.bytes)).not.toContain("ghp_");
    expect(elapsed).toBeLessThan(2_000);
  });
});
