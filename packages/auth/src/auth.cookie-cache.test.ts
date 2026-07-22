import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const authSource = readFileSync(
  fileURLToPath(new URL("./auth.ts", import.meta.url)),
  "utf8",
);

describe("Better Auth session cookie cache", () => {
  it("is enabled with a short maxAge and a required prod-equivalent verification note", () => {
    const sessionBlock = authSource.match(
      /session:\s*\{([\s\S]*?)\n\s*},\n\s*advanced:/,
    )?.[1];
    expect(
      sessionBlock,
      "auth.ts must define a session config block",
    ).toBeDefined();

    const cookieCache = sessionBlock?.match(
      /cookieCache:\s*\{([\s\S]*?)\}/,
    )?.[1];
    expect(
      cookieCache,
      "session.cookieCache must use Better Auth's supported object shape",
    ).toBeDefined();
    expect(cookieCache).toMatch(/enabled:\s*true\b/);

    const maxAge = Number(cookieCache?.match(/maxAge:\s*(\d+)\b/)?.[1]);
    expect(
      maxAge,
      "session.cookieCache.maxAge must be a positive number of seconds",
    ).toBeGreaterThan(0);
    expect(
      maxAge,
      "session.cookieCache.maxAge must not exceed the 60-second revocation window",
    ).toBeLessThanOrEqual(60);

    expect(
      sessionBlock,
      "prod-equivalent verification must be documented",
    ).toMatch(/prod-equivalent/i);
    expect(
      sessionBlock,
      "verification must be a required manual step before merge",
    ).toMatch(/REQUIRED manual step before merge/i);
  });
});
