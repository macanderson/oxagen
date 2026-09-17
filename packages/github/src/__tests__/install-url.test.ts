import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  GITHUB_SETTINGS_INSTALLATIONS_URL,
  buildIdentityAuthUrl,
  buildInstallAuthUrl,
  buildManageInstallationUrl,
  buildStateHmac,
  decodeState,
  encodeState,
  mintInstallState,
  parseReturnTo,
  verifyInstallState,
  type GithubInstallState,
} from "../install-url";

const SECRET = "state-secret";
const PAYLOAD = {
  orgId: "org-1",
  workspaceId: "ws-1",
  connectionId: null,
  returnTo: "settings" as const,
};

/** Pull the `{base64url}.{hmac}` state back out of a built URL. */
function stateOf(url: string): string {
  const raw = new URL(url).searchParams.get("state");
  if (raw === null) throw new Error(`no state in ${url}`);
  return raw;
}

function payloadOf(url: string): GithubInstallState {
  const state = stateOf(url);
  return JSON.parse(
    decodeState(state.slice(0, state.lastIndexOf("."))),
  ) as GithubInstallState;
}

describe("state encoding", () => {
  it("round-trips through base64url", () => {
    const json = JSON.stringify({ orgId: "o", note: "a/b+c?=" });
    expect(decodeState(encodeState(json))).toBe(json);
    expect(encodeState(json)).not.toContain("+");
    expect(encodeState(json)).not.toContain("/");
  });

  it("signs the JSON text, not the encoded form", () => {
    const json = '{"orgId":"o"}';
    expect(buildStateHmac(json, SECRET)).toBe(
      createHmac("sha256", SECRET).update(json).digest("hex"),
    );
  });
});

describe("parseReturnTo", () => {
  it("admits only the literal `settings`; everything else is the older surface", () => {
    expect(parseReturnTo("settings")).toBe("settings");
    expect(parseReturnTo("sources")).toBe("sources");
    // A state minted before the field existed, and anything a caller invents.
    expect(parseReturnTo(undefined)).toBe("sources");
    expect(parseReturnTo("Settings")).toBe("sources");
    expect(parseReturnTo("../evil")).toBe("sources");
  });
});

describe("mintInstallState", () => {
  it("carries the caller's payload, a fresh nonce and a 10-minute expiry", () => {
    const before = Date.now();
    const state = mintInstallState(SECRET, {
      orgId: "org-1",
      workspaceId: "ws-1",
      connectionId: "con_ABC",
      returnTo: "sources",
    });
    const json = decodeState(state.slice(0, state.lastIndexOf(".")));
    const parsed = JSON.parse(json) as GithubInstallState;

    expect(parsed).toMatchObject({
      orgId: "org-1",
      workspaceId: "ws-1",
      connectionId: "con_ABC",
      returnTo: "sources",
    });
    expect(parsed.nonce).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    const ttl = parsed.expiresAt - before;
    expect(ttl).toBeGreaterThan(9 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);
  });

  it("mints a different nonce every time, so one state is never replayable as another", () => {
    const a = mintInstallState(SECRET, PAYLOAD);
    const b = mintInstallState(SECRET, PAYLOAD);
    expect(a).not.toBe(b);
  });
});

describe("buildInstallAuthUrl", () => {
  it("is the App installation URL carrying the signed state, and no redirect_uri", () => {
    const url = buildInstallAuthUrl("oxagen-prod", SECRET, PAYLOAD);
    expect(
      url.startsWith(
        "https://github.com/apps/oxagen-prod/installations/new?state=",
      ),
    ).toBe(true);
    // The App's configured Callback URL is the post-install target.
    expect(url).not.toContain("redirect_uri");
    expect(payloadOf(url)).toMatchObject({
      orgId: "org-1",
      workspaceId: "ws-1",
      connectionId: null,
      returnTo: "settings",
    });
  });

  it("verifies against the same secret", () => {
    const url = buildInstallAuthUrl("oxagen-prod", SECRET, PAYLOAD);
    const result = verifyInstallState(stateOf(url), SECRET);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.state.orgId).toBe("org-1");
  });
});

describe("buildIdentityAuthUrl", () => {
  it("is the user-authorization URL with the client id and the signed state", () => {
    const url = buildIdentityAuthUrl("Iv1.abc", SECRET, {
      ...PAYLOAD,
      connectionId: "con_ABC",
      returnTo: "sources",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(parsed.searchParams.get("client_id")).toBe("Iv1.abc");
    expect(url).not.toContain("redirect_uri");
    expect(payloadOf(url)).toMatchObject({
      connectionId: "con_ABC",
      returnTo: "sources",
    });
  });
});

describe("manage URLs", () => {
  it("points at the App's own installations page", () => {
    expect(buildManageInstallationUrl("oxagen-prod")).toBe(
      "https://github.com/apps/oxagen-prod/installations/new",
    );
  });

  it("has a generic fallback for a deployment with no known slug", () => {
    expect(GITHUB_SETTINGS_INSTALLATIONS_URL).toBe(
      "https://github.com/settings/installations",
    );
  });
});

describe("verifyInstallState", () => {
  function sign(state: Partial<GithubInstallState>, secret = SECRET): string {
    const json = JSON.stringify({
      orgId: "org-1",
      workspaceId: "ws-1",
      connectionId: null,
      returnTo: "settings",
      expiresAt: Date.now() + 60_000,
      nonce: "n",
      ...state,
    });
    return `${encodeState(json)}.${buildStateHmac(json, secret)}`;
  }

  it("accepts a freshly minted state and returns the payload", () => {
    const result = verifyInstallState(sign({}), SECRET);
    expect(result).toEqual({
      ok: true,
      state: expect.objectContaining({ orgId: "org-1", returnTo: "settings" }),
    });
  });

  it("refuses a state with no `.` separator", () => {
    expect(verifyInstallState("no-dot-here", SECRET)).toEqual({
      ok: false,
      error: "invalid_format",
    });
  });

  it("refuses a signature minted with another secret", () => {
    expect(verifyInstallState(sign({}, "other-secret"), SECRET)).toEqual({
      ok: false,
      error: "invalid_signature",
    });
  });

  it("refuses a signature of the wrong length without comparing bytes", () => {
    const state = sign({});
    const truncated = `${state.slice(0, state.lastIndexOf(".") + 1)}abc`;
    expect(verifyInstallState(truncated, SECRET)).toEqual({
      ok: false,
      error: "invalid_signature",
    });
  });

  it("refuses a tampered payload — the org cannot be swapped under a good signature", () => {
    const state = sign({});
    const tamperedJson = JSON.stringify({
      orgId: "org-attacker",
      workspaceId: "ws-1",
      connectionId: null,
      returnTo: "settings",
      expiresAt: Date.now() + 60_000,
      nonce: "n",
    });
    const forged = `${encodeState(tamperedJson)}.${state.slice(state.lastIndexOf(".") + 1)}`;
    expect(verifyInstallState(forged, SECRET)).toEqual({
      ok: false,
      error: "invalid_signature",
    });
  });

  it("refuses a correctly signed body that is not JSON", () => {
    const json = "not json at all";
    const state = `${encodeState(json)}.${buildStateHmac(json, SECRET)}`;
    expect(verifyInstallState(state, SECRET)).toEqual({
      ok: false,
      error: "invalid_json",
    });
  });

  it("refuses an expired state", () => {
    expect(
      verifyInstallState(sign({ expiresAt: Date.now() - 1 }), SECRET),
    ).toEqual({ ok: false, error: "expired" });
  });

  it("judges expiry against the injected clock", () => {
    const state = sign({ expiresAt: 1_000 });
    expect(verifyInstallState(state, SECRET, 999).ok).toBe(true);
    expect(verifyInstallState(state, SECRET, 1_000).ok).toBe(true);
    expect(verifyInstallState(state, SECRET, 1_001)).toEqual({
      ok: false,
      error: "expired",
    });
  });

  it("accepts a state a URL round-trip percent-decoded", () => {
    const url = buildInstallAuthUrl("oxagen-prod", SECRET, PAYLOAD);
    const raw = new URL(url).searchParams.get("state") as string;
    expect(verifyInstallState(raw, SECRET).ok).toBe(true);
  });
});
