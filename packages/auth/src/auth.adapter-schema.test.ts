import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const authSource = readFileSync(
  fileURLToPath(new URL("./auth.ts", import.meta.url)),
  "utf8",
);

/**
 * The drizzleAdapter schema map is the single highest-consequence config in
 * this package and the one auth.test.ts cannot cover: its `drizzleAdapter`
 * mock discards the arguments, so a wrong model key there is invisible to
 * every other test in the suite.
 *
 * With `usePlural: true` Better Auth pluralizes EVERY model name before it
 * looks the key up in this map — user→users, session→sessions, and critically
 * the rate limiter's internal rateLimit→rateLimits and the twoFactor plugin's
 * twoFactor→twoFactors. A singular key there does not fail at boot; it throws
 * `model "rateLimits" was not found` on the very first auth request, which is
 * a total sign-in/sign-up outage. Local dev and e2e can mask it (see the
 * E2E rateLimit exemption in auth.ts), so a source-level guard is the only
 * thing that catches the regression before production does.
 *
 * Asserted as source text, matching the auth.cookie-cache.test.ts idiom: the
 * config is built once at module eval and the adapter call is not observable
 * from the captured betterAuth config.
 */
describe("drizzleAdapter schema map", () => {
  const adapterBlock = authSource.match(
    /drizzleAdapter\(db\(\),\s*\{([\s\S]*?)\n\s*\}\),/,
  )?.[1];

  it("auth.ts passes a drizzleAdapter schema block", () => {
    expect(
      adapterBlock,
      "auth.ts must configure drizzleAdapter(db(), { … })",
    ).toBeDefined();
  });

  it("keeps usePlural enabled — every model key below depends on it", () => {
    expect(adapterBlock).toMatch(/usePlural:\s*true/);
  });

  it.each([
    ["users", "schema.users"],
    ["sessions", "schema.sessions"],
    ["accounts", "schema.accounts"],
    ["verifications", "schema.verifications"],
    // The two pluralization landmines. Both have shipped as singular before
    // and both 500 every auth request when they do.
    ["rateLimits", "schema.rateLimitTable"],
    ["twoFactors", "schema.twoFactorTable"],
  ])("maps the plural model key %s → %s", (modelKey, table) => {
    expect(
      adapterBlock,
      `drizzleAdapter schema must map the PLURAL key "${modelKey}" to ${table}`,
    ).toMatch(new RegExp(`\\b${modelKey}:\\s*${table.replace(".", "\\.")}\\b`));
  });

  it.each(["rateLimit", "twoFactor"])(
    "never uses the singular model key %s",
    (singular) => {
      expect(
        adapterBlock,
        `"${singular}:" is the singular model key — usePlural means Better Auth ` +
          `looks up "${singular}s" and the adapter throws on every auth request`,
      ).not.toMatch(new RegExp(`\\b${singular}:\\s*schema\\.`));
    },
  );
});
