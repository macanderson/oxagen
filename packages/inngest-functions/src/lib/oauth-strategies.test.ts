/**
 * oauth-strategies — the shared provider refresh table + refreshOAuthToken
 * executor used by both the refresh cron and the poll-time resolver.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireEnv: vi.fn(), fetchMock: vi.fn() }));
vi.mock("@oxagen/config", () => ({ requireEnv: mocks.requireEnv }));

const {
  refreshOAuthToken,
  refreshProviderKeyFor,
  isRefreshError,
  PERMANENT_ERRORS,
} = await import("./oauth-strategies");

function jsonResponse(body: unknown) {
  return { json: () => Promise.resolve(body) } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetchMock);
  mocks.requireEnv.mockReturnValue({
    GITHUB_APP_CLIENT_ID: "id",
    GITHUB_APP_CLIENT_SECRET: "secret",
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("refreshProviderKeyFor", () => {
  it("normalizes google-* connector slugs onto the shared google strategy", () => {
    for (const slug of [
      "google-drive",
      "google-gmail",
      "google-calendar",
      "google-contacts",
      "google-meet",
      "google-tasks",
      "google-bigquery",
    ]) {
      expect(refreshProviderKeyFor(slug)).toBe("google");
    }
  });

  it("passes non-google providers through unchanged", () => {
    for (const p of [
      "github",
      "google",
      "slack",
      "zoom",
      "linear",
      "salesforce",
      "microsoft",
      "nope",
    ]) {
      expect(refreshProviderKeyFor(p)).toBe(p);
    }
  });
});

describe("refreshOAuthToken", () => {
  it("refreshes a google-drive slug via the shared google strategy", async () => {
    mocks.requireEnv.mockReturnValue({
      GOOGLE_DATA_CLIENT_ID: "gid",
      GOOGLE_DATA_CLIENT_SECRET: "gsecret",
    });
    mocks.fetchMock.mockResolvedValue(
      jsonResponse({ access_token: "new", expires_in: 3599 }),
    );
    const r = await refreshOAuthToken("google-drive", "tok");
    expect(isRefreshError(r)).toBe(false);
    expect(mocks.fetchMock).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns unsupported_provider for an unknown provider", async () => {
    const r = await refreshOAuthToken("nope", "tok");
    expect(r).toEqual({ error: "unsupported_provider" });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it("returns no_refresh_endpoint for a long-lived-token provider (Linear)", async () => {
    const r = await refreshOAuthToken("linear", "tok");
    expect(r).toEqual({ error: "no_refresh_endpoint" });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it("returns missing_client_env when the provider env vars are absent", async () => {
    mocks.requireEnv.mockImplementation(() => {
      throw new Error("missing");
    });
    const r = await refreshOAuthToken("github", "tok");
    expect(r).toEqual({ error: "missing_client_env" });
  });

  it("POSTs to the provider token endpoint and returns the parsed token", async () => {
    mocks.fetchMock.mockResolvedValue(
      jsonResponse({
        access_token: "new",
        refresh_token: "rot",
        expires_in: 3600,
      }),
    );
    const r = await refreshOAuthToken("github", "old-refresh");
    expect(mocks.fetchMock).toHaveBeenCalledWith(
      "https://github.com/login/oauth/access_token",
      expect.objectContaining({ method: "POST" }),
    );
    expect(r).toEqual({
      accessToken: "new",
      refreshToken: "rot",
      expiresInSec: 3600,
    });
  });

  it("surfaces a provider error object without throwing", async () => {
    mocks.fetchMock.mockResolvedValue(jsonResponse({ error: "invalid_grant" }));
    const r = await refreshOAuthToken("github", "old-refresh");
    expect(isRefreshError(r)).toBe(true);
    expect((r as { error: string }).error).toBe("invalid_grant");
  });

  it("returns http_error when the fetch itself throws", async () => {
    mocks.fetchMock.mockRejectedValue(new Error("network down"));
    const r = await refreshOAuthToken("github", "old-refresh");
    expect(r).toMatchObject({ error: "http_error" });
  });
});

describe("PERMANENT_ERRORS", () => {
  it("contains the standard revoked/invalid grant codes", () => {
    expect(PERMANENT_ERRORS.has("invalid_grant")).toBe(true);
    expect(PERMANENT_ERRORS.has("revoked_token")).toBe(true);
    expect(PERMANENT_ERRORS.has("temporarily_unavailable")).toBe(false);
  });
});
