/**
 * requireSession BYOK fallback: the CLI must run locally against the user's own
 * AI_GATEWAY_API_KEY instead of demanding `oxagen login` when a key is present.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let token: string | null = null;
let hasKey = true;
vi.mock("../config.js", () => ({
  getToken: () => token,
  getOrgId: () => (token ? "org" : null),
  getWorkspaceId: () => (token ? "ws" : null),
  getApiUrl: () => "https://api.test",
}));
vi.mock("../../agent/env.js", () => ({
  ensureGatewayKey: () => (hasKey ? "vck_test" : null),
}));

import { requireSession } from "../session.js";

beforeEach(() => {
  token = null;
  hasKey = true;
  delete process.env["OXAGEN_LOCAL"];
  delete process.env["OXAGEN_ALLOW_NO_SESSION"];
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("requireSession — local BYOK", () => {
  it("falls back to a synthetic local BYOK session when not logged in but a key is present", () => {
    token = null;
    hasKey = true;
    const s = requireSession();
    expect(s.synthetic).toBe(true);
    expect(s.orgSlug).toBe("local");
    expect(s.token).toBe(""); // no platform account
  });

  it("forces BYOK even when logged in if OXAGEN_LOCAL=1", () => {
    token = "real-token"; // logged in
    hasKey = true;
    process.env["OXAGEN_LOCAL"] = "1";
    const s = requireSession();
    expect(s.synthetic).toBe(true);
    expect(s.orgSlug).toBe("local");
  });

  it("returns the real platform session when logged in and not forcing local", () => {
    token = "real-token";
    hasKey = true;
    const s = requireSession();
    expect(s.synthetic).toBeUndefined();
    expect(s.token).toBe("real-token");
    expect(s.orgSlug).toBe("org");
  });

  it("exits when neither a session nor a gateway key is available", () => {
    token = null;
    hasKey = false;
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    expect(() => requireSession()).toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
