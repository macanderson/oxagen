/**
 * `apiPostOrThrow` with an explicit scope. A linked checkout names its own
 * org and workspace, and must be able to use them on a machine whose global
 * config has never selected either: only the token is required then.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({
  token: "tok_1" as string | undefined,
  org: undefined as string | undefined,
  ws: undefined as string | undefined,
}));

vi.mock("./config.js", () => ({
  getToken: () => config.token,
  getOrgId: () => config.org,
  getWorkspaceId: () => config.ws,
  getApiUrl: () => "https://api.example.invalid",
}));

import { apiGetOrThrow, apiPostOrThrow } from "./api";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  config.token = "tok_1";
  config.org = undefined;
  config.ws = undefined;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiPostOrThrow with an explicit scope", () => {
  it("needs only the token when the caller names the org and workspace", async () => {
    await apiPostOrThrow(
      "context/steering/freshness",
      {},
      {
        org: "acme",
        ws: "payments",
      },
    );
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://api.example.invalid/v1/acme/payments/context/steering/freshness",
    );
  });

  it("still refuses without a token", async () => {
    config.token = undefined;
    await expect(
      apiPostOrThrow("x", {}, { org: "acme", ws: "payments" }),
    ).rejects.toThrow(/Not logged in/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still needs the global selection when no scope is given", async () => {
    await expect(apiPostOrThrow("x", {})).rejects.toThrow(/Not logged in/);
    config.org = "acme";
    config.ws = "core";
    await apiPostOrThrow("x", {});
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v1/acme/core/x");
  });

  it("passes a timeout through as an abort signal", async () => {
    await apiPostOrThrow("x", {}, { org: "a", ws: "b" }, { timeoutMs: 50 });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("apiGetOrThrow with an explicit scope", () => {
  it("addresses the named org and workspace with only the token", async () => {
    await apiGetOrThrow(
      "connections",
      { connectorId: "github" },
      { org: "acme", ws: "payments" },
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.example.invalid/v1/acme/payments/connections?connectorId=github",
    );
  });

  it("still refuses without a token", async () => {
    config.token = undefined;
    await expect(
      apiGetOrThrow("x", undefined, { org: "acme", ws: "payments" }),
    ).rejects.toThrow(/Not logged in/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still needs the global selection when no scope is given", async () => {
    await expect(apiGetOrThrow("x")).rejects.toThrow(/Not logged in/);
  });
});
