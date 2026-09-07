/**
 * `lib/api.ts` — the org-scoped HTTP seam every platform command goes through.
 *
 * Covers the URL/auth shape of each verb (GET / user-POST / POST / PUT), the
 * happy-path JSON return, the missing-scope contract (throw vs. exit), the
 * network- and HTTP-error paths, and `printTable`'s alignment. The diagnostic
 * *payload* those errors log is covered separately in api.test.ts; here we care
 * about the request that goes out and the control flow that comes back.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const scope = vi.hoisted(() => ({
  apiUrl: "https://api.oxagen.sh",
  token: "tok_test" as string | undefined,
  org: "acme" as string | undefined,
  ws: "prod" as string | undefined,
}));

vi.mock("../config.js", () => ({
  getApiUrl: () => scope.apiUrl,
  getToken: () => scope.token,
  getOrgId: () => scope.org,
  getWorkspaceId: () => scope.ws,
}));

vi.mock("../debug-log.js", () => ({
  debugLog: vi.fn(() => Promise.resolve()),
  isDebugEnabled: () => false,
}));

import {
  ApiError,
  apiGetOrThrow,
  apiPost,
  apiPostOrThrow,
  apiPutOrThrow,
  printTable,
  resolveApiContext,
  userApiPostOrThrow,
} from "../api.js";
import type { CommandWriter } from "../capture-writer.js";

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

function ok(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function failing(status: number, body = "boom"): Response {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

function captureWriter(): { writer: CommandWriter; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    writer: { write: (l) => void out.push(l), writeErr: (l) => void err.push(l) },
    out,
    err,
  };
}

beforeEach(() => {
  scope.apiUrl = "https://api.oxagen.sh";
  scope.token = "tok_test";
  scope.org = "acme";
  scope.ws = "prod";
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("resolveApiContext", () => {
  it("returns the full scope when token, org, and workspace are all present", () => {
    expect(resolveApiContext()).toEqual({
      apiUrl: "https://api.oxagen.sh",
      token: "tok_test",
      org: "acme",
      ws: "prod",
    });
  });

  it.each([["token"], ["org"], ["ws"]] as const)(
    "returns null when %s is missing",
    (missing) => {
      scope[missing] = undefined;
      expect(resolveApiContext()).toBeNull();
    },
  );
});

describe("apiGetOrThrow", () => {
  it("builds an org-scoped URL and sends a bearer token", async () => {
    fetchMock.mockResolvedValue(ok({ connections: [] }));
    await expect(apiGetOrThrow("connections")).resolves.toEqual({
      connections: [],
    });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://api.oxagen.sh/v1/acme/prod/connections",
    );
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer tok_test",
    );
  });

  it("appends defined query params and drops null/undefined ones", async () => {
    fetchMock.mockResolvedValue(ok({}));
    await apiGetOrThrow("connections", {
      connectorId: "github",
      limit: 5,
      cursor: null,
      after: undefined,
    });
    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.searchParams.get("connectorId")).toBe("github");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.has("cursor")).toBe(false);
    expect(url.searchParams.has("after")).toBe(false);
  });

  it("throws the not-logged-in error without calling fetch", async () => {
    scope.token = undefined;
    await expect(apiGetOrThrow("connections")).rejects.toThrow(ApiError);
    await expect(apiGetOrThrow("connections")).rejects.toThrow("Not logged in");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("wraps a transport failure in an ApiError naming the path", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(apiGetOrThrow("connections")).rejects.toThrow(
      /Network error calling connections/,
    );
  });

  it("throws on a non-2xx response", async () => {
    fetchMock.mockResolvedValue(failing(503));
    await expect(apiGetOrThrow("connections")).rejects.toThrow(ApiError);
  });
});

describe("userApiPostOrThrow", () => {
  it("posts to the user-scoped path with no org or workspace segment", async () => {
    fetchMock.mockResolvedValue(ok({ organizations: [] }));
    await userApiPostOrThrow("organizations", {});
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.oxagen.sh/v1/user/organizations");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
  });

  it("serializes a null body as an empty object", async () => {
    fetchMock.mockResolvedValue(ok({}));
    await userApiPostOrThrow("organizations", null);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe("{}");
  });

  it("needs only a token, not org or workspace", async () => {
    scope.org = undefined;
    scope.ws = undefined;
    fetchMock.mockResolvedValue(ok({ ok: true }));
    await expect(userApiPostOrThrow("organizations", {})).resolves.toEqual({
      ok: true,
    });
  });

  it("throws without a token and never calls fetch", async () => {
    scope.token = undefined;
    await expect(userApiPostOrThrow("organizations", {})).rejects.toThrow(
      "Not logged in",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on a transport failure and on a non-2xx response", async () => {
    fetchMock.mockRejectedValueOnce(new Error("dns"));
    await expect(userApiPostOrThrow("organizations", {})).rejects.toThrow(
      ApiError,
    );
    fetchMock.mockResolvedValueOnce(failing(401));
    await expect(userApiPostOrThrow("organizations", {})).rejects.toThrow(
      ApiError,
    );
  });
});

describe("apiPostOrThrow", () => {
  it("posts JSON to the org-scoped path", async () => {
    fetchMock.mockResolvedValue(ok({ binding: { id: "aeb_1" } }));
    await expect(
      apiPostOrThrow("agent/environment/bind", { agentId: "agt_1" }),
    ).resolves.toEqual({ binding: { id: "aeb_1" } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.oxagen.sh/v1/acme/prod/agent/environment/bind",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ agentId: "agt_1" });
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
  });

  it("throws without scope, on transport failure, and on non-2xx", async () => {
    scope.ws = undefined;
    await expect(apiPostOrThrow("x", {})).rejects.toThrow("Not logged in");
    scope.ws = "prod";
    fetchMock.mockRejectedValueOnce(new Error("reset"));
    await expect(apiPostOrThrow("x", {})).rejects.toThrow(ApiError);
    fetchMock.mockResolvedValueOnce(failing(500));
    await expect(apiPostOrThrow("x", {})).rejects.toThrow(ApiError);
  });
});

describe("apiPutOrThrow", () => {
  it("PUTs JSON to the same URL the read path uses", async () => {
    fetchMock.mockResolvedValue(ok({ budgets: [] }));
    await expect(
      apiPutOrThrow("billing/budget", { scope: "org", limitUsd: 500 }),
    ).resolves.toEqual({ budgets: [] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.oxagen.sh/v1/acme/prod/billing/budget");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      scope: "org",
      limitUsd: 500,
    });
  });

  it("throws without scope, on transport failure, and on non-2xx", async () => {
    scope.org = undefined;
    await expect(apiPutOrThrow("billing/budget", {})).rejects.toThrow(
      "Not logged in",
    );
    scope.org = "acme";
    fetchMock.mockRejectedValueOnce(new Error("reset"));
    await expect(apiPutOrThrow("billing/budget", {})).rejects.toThrow(ApiError);
    fetchMock.mockResolvedValueOnce(failing(403));
    await expect(apiPutOrThrow("billing/budget", {})).rejects.toThrow(ApiError);
  });
});

describe("apiPost", () => {
  it("returns the parsed body on success", async () => {
    fetchMock.mockResolvedValue(ok({ environments: [] }));
    const { writer } = captureWriter();
    await expect(apiPost("environment/list", {}, writer)).resolves.toEqual({
      environments: [],
    });
  });

  it("writes the not-logged-in message and throws for a capture writer", async () => {
    scope.token = undefined;
    const { writer, err } = captureWriter();
    await expect(apiPost("environment/list", {}, writer)).rejects.toThrow(
      ApiError,
    );
    expect(err[0]).toContain("Not logged in");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes the failure message and rethrows an ApiError for a capture writer", async () => {
    fetchMock.mockResolvedValue(failing(500));
    const { writer, err } = captureWriter();
    await expect(apiPost("environment/list", {}, writer)).rejects.toThrow(
      ApiError,
    );
    expect(err.join("\n")).not.toBe("");
  });
});

describe("printTable", () => {
  it("pads every column to the widest cell, header included", () => {
    const { writer, out } = captureWriter();
    printTable(
      ["ENVIRONMENT", "SLUG"],
      [
        ["Production", "prod"],
        ["A Much Longer Name", "x"],
      ],
      writer,
    );
    expect(out).toHaveLength(3);
    const width = out[0]!.indexOf("SLUG");
    expect(out[1]!.indexOf("prod")).toBe(width);
    expect(out[2]!.indexOf("x")).toBe(width);
  });

  it("tolerates a short row without throwing", () => {
    const { writer, out } = captureWriter();
    printTable(["A", "B"], [["only-a"]], writer);
    expect(out[1]).toContain("only-a");
  });
});
