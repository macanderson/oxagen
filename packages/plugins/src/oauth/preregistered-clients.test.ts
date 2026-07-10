import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import {
  parsePreregisteredClients,
  preregisteredClientForEndpoint,
  resetPreregisteredClientsWarning,
} from "./preregistered-clients";

beforeEach(() => {
  resetPreregisteredClientsWarning();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("parsePreregisteredClients", () => {
  it("parses a host → client map", () => {
    const map = parsePreregisteredClients(
      JSON.stringify({
        "api.githubcopilot.com": {
          client_id: "gh-id",
          client_secret: "gh-secret",
        },
        "mcp.example.com": { client_id: "ex-id" },
      }),
    );
    expect(map.get("api.githubcopilot.com")).toEqual({
      client_id: "gh-id",
      client_secret: "gh-secret",
    });
    // Secret is optional (public clients).
    expect(map.get("mcp.example.com")).toEqual({ client_id: "ex-id" });
  });

  it("lowercases host keys", () => {
    const map = parsePreregisteredClients(
      JSON.stringify({ "API.GitHubCopilot.COM": { client_id: "gh-id" } }),
    );
    expect(map.get("api.githubcopilot.com")?.client_id).toBe("gh-id");
  });

  it("returns an empty map for undefined / empty env", () => {
    expect(parsePreregisteredClients(undefined).size).toBe(0);
    expect(parsePreregisteredClients("").size).toBe(0);
    expect(parsePreregisteredClients("   ").size).toBe(0);
  });

  it("ignores malformed JSON and warns exactly once", () => {
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    expect(parsePreregisteredClients("{not json").size).toBe(0);
    expect(parsePreregisteredClients("{still not json").size).toBe(0);
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it("ignores non-object roots and entries without a client_id", () => {
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    expect(parsePreregisteredClients(JSON.stringify(["a"])).size).toBe(0);
    expect(errSpy).toHaveBeenCalledTimes(1);
    const map = parsePreregisteredClients(
      JSON.stringify({
        "a.example.com": { client_secret: "orphan-secret" },
        "b.example.com": { client_id: "" },
        "c.example.com": null,
        "d.example.com": { client_id: "ok" },
      }),
    );
    expect(map.size).toBe(1);
    expect(map.get("d.example.com")?.client_id).toBe("ok");
  });
});

describe("preregisteredClientForEndpoint", () => {
  const raw = JSON.stringify({
    "api.githubcopilot.com": { client_id: "gh-id", client_secret: "gh-secret" },
  });

  it("matches by the endpoint URL's host", () => {
    expect(
      preregisteredClientForEndpoint("https://api.githubcopilot.com/mcp/", raw),
    ).toEqual({ client_id: "gh-id", client_secret: "gh-secret" });
  });

  it("returns undefined for an unconfigured host", () => {
    expect(
      preregisteredClientForEndpoint("https://mcp.stripe.com", raw),
    ).toBeUndefined();
  });

  it("returns undefined for an unparseable endpoint URL", () => {
    expect(preregisteredClientForEndpoint("not a url", raw)).toBeUndefined();
  });

  it("reads MCP_OAUTH_PREREGISTERED_CLIENTS by default", () => {
    vi.stubEnv("MCP_OAUTH_PREREGISTERED_CLIENTS", raw);
    expect(
      preregisteredClientForEndpoint("https://api.githubcopilot.com/mcp/")
        ?.client_id,
    ).toBe("gh-id");
  });
});
