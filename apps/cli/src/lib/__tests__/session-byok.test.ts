/**
 * requireSession BYOK fallback: the CLI must run locally against the user's own
 * key — AI_GATEWAY_API_KEY (any vendor) or ANTHROPIC_API_KEY (Anthropic models
 * only) — instead of demanding `oxagen login` when a key is present.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AiCredential } from "../../agent/env.js";

let token: string | null = null;
let credential: AiCredential | null = { source: "gateway", key: "vck_test" };
vi.mock("../config.js", () => ({
  getToken: () => token,
  getOrgId: () => (token ? "org" : null),
  getWorkspaceId: () => (token ? "ws" : null),
  getApiUrl: () => "https://api.test",
}));
vi.mock("../../agent/env.js", () => ({
  resolveAiCredential: () => credential,
}));

import { requireSession } from "../session.js";

beforeEach(() => {
  token = null;
  credential = { source: "gateway", key: "vck_test" };
  delete process.env["OXAGEN_LOCAL"];
  delete process.env["OXAGEN_ALLOW_NO_SESSION"];
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("requireSession — local BYOK", () => {
  it("falls back to a synthetic local BYOK session when not logged in but a gateway key is present", () => {
    token = null;
    const s = requireSession();
    expect(s.synthetic).toBe(true);
    expect(s.orgSlug).toBe("local");
    expect(s.token).toBe(""); // no platform account
  });

  it("falls back to local BYOK with only an ANTHROPIC_API_KEY, noting the Anthropic-only scope", () => {
    token = null;
    credential = { source: "anthropic", key: "sk-ant-test" };
    const s = requireSession();
    expect(s.synthetic).toBe(true);
    expect(s.orgSlug).toBe("local");
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("ANTHROPIC_API_KEY (Anthropic models only)"),
    );
  });

  it("forces BYOK even when logged in if OXAGEN_LOCAL=1", () => {
    token = "real-token"; // logged in
    process.env["OXAGEN_LOCAL"] = "1";
    const s = requireSession();
    expect(s.synthetic).toBe(true);
    expect(s.orgSlug).toBe("local");
  });

  it("forces BYOK with only an Anthropic key when OXAGEN_LOCAL=1", () => {
    token = "real-token";
    credential = { source: "anthropic", key: "sk-ant-test" };
    process.env["OXAGEN_LOCAL"] = "1";
    const s = requireSession();
    expect(s.synthetic).toBe(true);
  });

  it("returns the real platform session when logged in and not forcing local", () => {
    token = "real-token";
    const s = requireSession();
    expect(s.synthetic).toBeUndefined();
    expect(s.token).toBe("real-token");
    expect(s.orgSlug).toBe("org");
  });

  it("exits when neither a session nor any AI key is available", () => {
    token = null;
    credential = null;
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    expect(() => requireSession()).toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
