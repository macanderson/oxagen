// scrub.test.ts: the scrubber keeps each secret a discovery run placed out
// of the text it stores, logs, or sends (lane M10, #4682). Each case checks
// that the secret string is absent from what comes back.
import { describe, expect, it } from "vitest";
import {
  createScrubber,
  REDACTED,
  scrubbedMessage,
  scrubValue,
  type Scrubber,
} from "./scrub";

const TOKEN = "ghp_live_token_1234";

function scrubberFor(...secrets: string[]): Scrubber {
  const scrubber = createScrubber();
  for (const secret of secrets) scrubber.add(secret);
  return scrubber;
}

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

describe("REDACTED", () => {
  it("is the marker that replaces a secret", () => {
    expect(REDACTED).toBe("[redacted]");
  });
});

describe("createScrubber", () => {
  it("leaves text alone when it knows no secret", () => {
    expect(createScrubber().scrub(`Bearer ${TOKEN}`)).toBe(`Bearer ${TOKEN}`);
  });

  it("replaces every copy of a secret", () => {
    const out = scrubberFor(TOKEN).scrub(`${TOKEN} and again ${TOKEN}.`);
    expect(out).toBe("[redacted] and again [redacted].");
    expect(out).not.toContain(TOKEN);
  });

  it("replaces the URL-encoded form of a secret", () => {
    const secret = "a b/c+d=e";
    const encoded = encodeURIComponent(secret);
    expect(encoded).toBe("a%20b%2Fc%2Bd%3De");
    const out = scrubberFor(secret).scrub(`GET /tools?key=${encoded}`);
    expect(out).toBe("GET /tools?key=[redacted]");
    expect(out).not.toContain(encoded);
  });

  it("replaces the base64 form of a secret", () => {
    const encoded = base64(`user:${TOKEN}`);
    const out = scrubberFor(`user:${TOKEN}`).scrub(`Basic ${encoded}`);
    expect(out).toBe("Basic [redacted]");
    expect(out).not.toContain(encoded);
  });

  it("replaces several secrets in one text", () => {
    const out = scrubberFor(TOKEN, "hunter22").scrub(
      `token=${TOKEN}&password=hunter22`,
    );
    expect(out).toBe("token=[redacted]&password=[redacted]");
  });

  it("replaces a secret that contains another as a whole", () => {
    // The shorter secret is added first, so only the length order keeps the
    // tail of the longer one out of the text.
    const out = scrubberFor("secret-token", "secret-token-long").scrub(
      "value=secret-token-long and secret-token",
    );
    expect(out).toBe("value=[redacted] and [redacted]");
    expect(out).not.toContain("-long");
  });

  it("keeps a secret shorter than four characters but scrubs its base64", () => {
    const scrubber = scrubberFor("abc");
    expect(base64("abc")).toBe("YWJj");
    expect(scrubber.scrub("abc YWJj")).toBe("abc [redacted]");
  });

  it("does not erase text for a one-letter secret", () => {
    expect(scrubberFor("a").scrub("a quick test")).toBe("a quick test");
  });

  it("ignores an empty secret", () => {
    expect(scrubberFor("").scrub("hello")).toBe("hello");
  });

  it("matches a secret with regular expression characters literally", () => {
    const out = scrubberFor("a.b*c+d").scrub("x a.b*c+d y axbbbc+d");
    expect(out).toBe("x [redacted] y axbbbc+d");
  });
});

describe("scrubbedMessage", () => {
  const scrubber = scrubberFor(TOKEN);

  it("scrubs an error's message", () => {
    const out = scrubbedMessage(scrubber, new Error(`401 for ${TOKEN}`));
    expect(out).toBe("401 for [redacted]");
  });

  it("scrubs a thrown string", () => {
    expect(scrubbedMessage(scrubber, `bad ${TOKEN}`)).toBe("bad [redacted]");
  });

  it("writes any other value as a string", () => {
    expect(scrubbedMessage(scrubber, 404)).toBe("404");
    expect(scrubbedMessage(scrubber, { status: 404 })).toBe("[object Object]");
    expect(scrubbedMessage(scrubber, null)).toBe("null");
    expect(scrubbedMessage(scrubber, undefined)).toBe("undefined");
  });

  it("cuts a long message to the limit with an ellipsis", () => {
    const out = scrubbedMessage(scrubber, "x".repeat(30), 10);
    expect(out).toBe(`${"x".repeat(9)}…`);
    expect(out).toHaveLength(10);
  });

  it("keeps a message exactly at the limit", () => {
    expect(scrubbedMessage(scrubber, "x".repeat(10), 10)).toBe("x".repeat(10));
  });

  it("cuts at 2000 characters by default", () => {
    const long = scrubbedMessage(scrubber, "y".repeat(2500));
    expect(long).toHaveLength(2000);
    expect(long.endsWith("…")).toBe(true);
    expect(scrubbedMessage(scrubber, "y".repeat(2000))).toBe("y".repeat(2000));
  });

  it("scrubs before it cuts, so no part of a secret survives the cut", () => {
    const secret = "abcdefghij";
    const out = scrubbedMessage(scrubberFor(secret), `zzzzzzzz${secret}`, 12);
    expect(out).toBe("zzzzzzzz[re…");
    expect(out).not.toContain("abc");
  });
});

describe("scrubValue", () => {
  const scrubber = scrubberFor(TOKEN);

  it("scrubs a string", () => {
    expect(scrubValue(scrubber, `Bearer ${TOKEN}`)).toBe("Bearer [redacted]");
  });

  it("scrubs keys and values in nested objects and arrays", () => {
    const input = {
      headers: { Authorization: `Bearer ${TOKEN}` },
      list: [TOKEN, { deep: `x${TOKEN}x` }],
      [TOKEN]: "value",
      count: 3,
      ok: true,
      none: null,
    };
    const out = scrubValue(scrubber, input);
    expect(out).toEqual({
      headers: { Authorization: "Bearer [redacted]" },
      list: ["[redacted]", { deep: "x[redacted]x" }],
      "[redacted]": "value",
      count: 3,
      ok: true,
      none: null,
    });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it("scrubs a top-level array", () => {
    expect(scrubValue(scrubber, [TOKEN, 1])).toEqual(["[redacted]", 1]);
  });

  it("returns numbers, booleans, null, and undefined as they are", () => {
    expect(scrubValue(scrubber, 42)).toBe(42);
    expect(scrubValue(scrubber, true)).toBe(true);
    expect(scrubValue(scrubber, null)).toBeNull();
    expect(scrubValue(scrubber, undefined)).toBeUndefined();
  });

  it("leaves the input unchanged", () => {
    const input = { headers: { Authorization: `Bearer ${TOKEN}` } };
    const out = scrubValue(scrubber, input);
    expect(out).not.toBe(input);
    expect(input.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});
