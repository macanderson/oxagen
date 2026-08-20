import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const authSource = readFileSync(
  fileURLToPath(new URL("./auth.ts", import.meta.url)),
  "utf8",
);

describe("Better Auth session cookie cache", () => {
  it("is deliberately disabled, with the RSC cookie-write rationale documented", () => {
    const sessionBlock = authSource.match(
      /session:\s*\{([\s\S]*?)\n\s*},\n\s*advanced:/,
    )?.[1];
    expect(
      sessionBlock,
      "auth.ts must define a session config block",
    ).toBeDefined();

    // Policy (commit 9c9825c64): cookieCache stays disabled. With it enabled,
    // Better Auth called response.headers.set() to refresh the session cookie
    // when the cache expired mid-render; Next.js 16 forbids cookie writes
    // outside Server Actions / Route Handlers, producing a Runtime APIError:
    // "Failed to get session". Per-request DB session reads are the accepted
    // trade-off. Re-enabling this is a security- and stability-relevant
    // change and must come with a stated reason, not a silent config flip.
    const cookieCache = sessionBlock?.match(
      /cookieCache:\s*\{([\s\S]*?)\}/,
    )?.[1];
    expect(
      cookieCache?.match(/enabled:\s*true\b/),
      "session.cookieCache must not be enabled — it breaks RSC renders " +
        "under Next.js 16 (cookie writes are forbidden outside Server " +
        "Actions / Route Handlers). Re-enabling requires a stated reason.",
    ).toBeFalsy();

    expect(
      sessionBlock,
      "the reason cookieCache is disabled must be documented in the session block",
    ).toMatch(/cookieCache intentionally omitted/i);
    expect(
      sessionBlock,
      "the RSC cookie-write failure mode must be documented",
    ).toMatch(/forbids cookie writes/i);
  });
});
