/**
 * The password policy (#3888): the pure rule the app's screens share, and the
 * plugin that makes the server refuse what the screens refuse.
 */
import { describe, expect, it, vi } from "vitest";

// createAuthMiddleware is the identity here so the hook in the plugin is the
// plain async function password-policy-plugin.ts wrote.
vi.mock("better-auth/api", () => ({
  APIError: class APIError extends Error {
    constructor(
      readonly status: string,
      readonly body: { code?: string; message?: string },
    ) {
      super(body.message);
    }
  },
  createAuthMiddleware: (fn: unknown) => fn,
}));

import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  PASSWORD_TOO_WEAK_CODE,
  passwordPolicyViolation,
  passwordRequirements,
} from "./password-policy";
import {
  PASSWORD_POLICY_PLUGIN_ID,
  passwordPolicyPlugin,
} from "./password-policy-plugin";

type Hook = {
  matcher: (ctx: { path?: string }) => boolean;
  handler: (ctx: { path?: string; body?: unknown }) => Promise<unknown>;
};

const STRONG = "correct-horse-7";

function hook(): Hook {
  const plugin = passwordPolicyPlugin();
  expect(plugin.id).toBe(PASSWORD_POLICY_PLUGIN_ID);
  return plugin.hooks!.before![0] as unknown as Hook;
}

describe("passwordRequirements", () => {
  it("ticks each requirement on its own", () => {
    expect(passwordRequirements("")).toEqual({
      length: false,
      symbol: false,
      digit: false,
    });
    expect(passwordRequirements("abc!")).toEqual({
      length: false,
      symbol: true,
      digit: false,
    });
    expect(passwordRequirements("abcdefghijk7")).toEqual({
      length: true,
      symbol: false,
      digit: true,
    });
  });
});

describe("passwordPolicyViolation", () => {
  it("accepts a password that meets every rule", () => {
    expect(passwordPolicyViolation(STRONG)).toBeNull();
    expect(passwordPolicyViolation(`${"a".repeat(126)}!7`)).toBeNull();
  });

  it.each([
    ["short!7", `at least ${PASSWORD_MIN} characters`],
    ["abcdefghijk7", "one symbol"],
    ["abcdefghijk!", "one digit"],
    [`${"a".repeat(PASSWORD_MAX)}!7`, `at most ${PASSWORD_MAX} characters`],
  ])("names the rule %j misses", (value, rule) => {
    expect(passwordPolicyViolation(value)).toContain(rule);
  });

  it("names the rules in the order the screens list them", () => {
    expect(passwordPolicyViolation("abc")).toContain("characters");
    expect(passwordPolicyViolation("abcdefghijkl")).toContain("symbol");
  });
});

describe("passwordPolicyPlugin", () => {
  it("runs on every endpoint that sets a password, and nowhere else", () => {
    const { matcher } = hook();
    expect(matcher({ path: "/sign-up/email" })).toBe(true);
    expect(matcher({ path: "/reset-password" })).toBe(true);
    expect(matcher({ path: "/change-password" })).toBe(true);
    expect(matcher({ path: "/sign-in/email" })).toBe(false);
    expect(matcher({ path: "/toString" })).toBe(false);
    expect(matcher({})).toBe(false);
  });

  it.each([
    ["/sign-up/email", "password"],
    ["/reset-password", "newPassword"],
    ["/change-password", "newPassword"],
  ])("refuses an 8-character password on %s", async (path, field) => {
    await expect(
      hook().handler({ path, body: { [field]: "abcdef!7" } }),
    ).rejects.toMatchObject({
      status: "BAD_REQUEST",
      body: {
        code: PASSWORD_TOO_WEAK_CODE,
        message: `Password must be at least ${PASSWORD_MIN} characters.`,
      },
    });
  });

  it("refuses a long password with no symbol or no digit", async () => {
    const { handler } = hook();
    await expect(
      handler({ path: "/sign-up/email", body: { password: "abcdefghijk7" } }),
    ).rejects.toMatchObject({
      body: {
        code: PASSWORD_TOO_WEAK_CODE,
        message: "Password must contain at least one symbol.",
      },
    });
    await expect(
      handler({
        path: "/reset-password",
        body: { newPassword: "abcdefghijk!", token: "t" },
      }),
    ).rejects.toMatchObject({
      body: {
        code: PASSWORD_TOO_WEAK_CODE,
        message: "Password must contain at least one digit.",
      },
    });
  });

  it("lets a password that meets the policy through", async () => {
    await expect(
      hook().handler({ path: "/sign-up/email", body: { password: STRONG } }),
    ).resolves.toBeUndefined();
  });

  it("leaves a missing password to Better Auth's own validation", async () => {
    const { handler } = hook();
    await expect(
      handler({ path: "/sign-up/email", body: {} }),
    ).resolves.toBeUndefined();
    await expect(
      handler({ path: "/reset-password", body: undefined }),
    ).resolves.toBeUndefined();
    await expect(
      handler({ path: "/sign-in/email", body: { password: "x" } }),
    ).resolves.toBeUndefined();
  });
});
