import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./config.js", () => ({
  getToken: vi.fn(() => "test-token"),
  getApiUrl: vi.fn(() => "http://localhost:4000"),
}));

import { apiRequest, requireAuth, ApiError } from "./api-client.js";
import * as config from "./config.js";

const mockGetToken = vi.mocked(config.getToken);

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetToken.mockReturnValue("test-token");
});

describe("apiRequest", () => {
  it("calls the correct URL with auth header", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    });

    const result = await apiRequest("/conversations");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:4000/api/v1/conversations",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
      }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("omits Authorization header when no token", async () => {
    mockGetToken.mockReturnValue(undefined);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    await apiRequest("/health");

    const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("throws ApiError with status on non-ok response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: "Unauthorized" }),
    });

    const err = await apiRequest("/me").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect((err as ApiError).message).toBe("Unauthorized");

    mockFetch.mockReset();
  });

  it("throws ApiError with generic message if body parse fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => { throw new Error("parse fail"); },
    });

    await expect(apiRequest("/fail")).rejects.toMatchObject({ status: 500 });
  });

  it("sends POST body as JSON", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 1 }) });

    await apiRequest("/things", {
      method: "POST",
      body: JSON.stringify({ name: "test" }),
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init?.body).toBe(JSON.stringify({ name: "test" }));
  });
});

describe("requireAuth", () => {
  it("does nothing when token is present", () => {
    mockGetToken.mockReturnValue("tok");
    expect(() => requireAuth()).not.toThrow();
  });

  it("calls process.exit(1) when no token", () => {
    mockGetToken.mockReturnValue(undefined);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });

    expect(() => requireAuth()).toThrow("exit");
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("not authenticated"));
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe("ApiError", () => {
  it("has correct name and status", () => {
    const err = new ApiError(404, "Not found");
    expect(err.name).toBe("ApiError");
    expect(err.status).toBe(404);
    expect(err.message).toBe("Not found");
    expect(err instanceof Error).toBe(true);
  });
});
