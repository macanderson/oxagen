import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRegistryProbeCacheForTests,
  declaredAuth,
  httpsUrl,
  publisherOf,
  searchMcpRegistry,
  toRegistryServer,
} from "./mcp-registry";
import { searchVerifiedServers } from "./verified-mcp-servers";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const LINEAR_COPY = {
  server: {
    name: "app.linear/linear",
    title: "Linear",
    description: "Linear issues",
    version: "1.0.1",
    websiteUrl: "https://linear.app",
    remotes: [{ type: "streamable-http", url: "https://mcp.linear.app/mcp" }],
  },
};
const ACME = {
  server: {
    name: "com.acme/tickets",
    title: "Acme Tickets",
    description: "Tickets at Acme",
    version: "2.0.0",
    icons: [
      { src: "http://acme.example/i.png" },
      { src: "https://acme.example/i.png" },
    ],
    repository: { url: "https://github.com/acme/tickets" },
    remotes: [{ type: "streamable-http", url: "https://mcp.acme.example/mcp" }],
  },
};
const KEYED = {
  server: {
    name: "io.github.someone/keyed",
    description: "Needs a key",
    version: "0.1.0",
    remotes: [
      {
        type: "streamable-http",
        url: "https://keyed.example/mcp",
        headers: [{ name: "X-Api-Key", isSecret: true }],
      },
    ],
  },
};
const LOCAL = {
  server: {
    name: "io.github.someone/local",
    description: "Runs on your machine",
    version: "0.1.0",
    packages: [
      { registryType: "npm", identifier: "x", transport: { type: "stdio" } },
    ],
  },
};

describe("registry normalization", () => {
  it("reads a reverse-DNS name as a verified domain and io.github as an account", () => {
    expect(publisherOf("app.linear/linear")).toEqual({
      publisher: "linear.app",
      verified: true,
    });
    expect(publisherOf("io.github.someone/keyed")).toEqual({
      publisher: "github.com/someone",
      verified: false,
    });
  });

  it("keeps only https URLs without credentials", () => {
    expect(httpsUrl("https://a.example/x")).toBe("https://a.example/x");
    expect(httpsUrl("http://a.example/x")).toBeNull();
    expect(httpsUrl("https://u:p@a.example/")).toBeNull();
    expect(httpsUrl("javascript:alert(1)")).toBeNull();
    expect(httpsUrl(42)).toBeNull();
  });

  it("maps a declared secret header to bearer or header auth", () => {
    expect(declaredAuth([{ name: "Authorization", isSecret: true }])).toEqual({
      auth: "bearer",
      header: "Authorization",
    });
    expect(declaredAuth([{ name: "X-Api-Key", isRequired: true }])).toEqual({
      auth: "header",
      header: "X-Api-Key",
    });
    expect(declaredAuth(undefined)).toEqual({ auth: null, header: null });
  });

  it("normalizes a remote server, picking the first https icon", () => {
    const server = toRegistryServer(ACME);
    expect(server).toMatchObject({
      id: "com.acme/tickets",
      name: "Acme Tickets",
      publisher: "acme.com",
      publisherVerified: true,
      source: "registry",
      iconUrl: "https://acme.example/i.png",
      endpointUrl: "https://mcp.acme.example/mcp",
      transports: ["streamable-http"],
      auth: "unknown",
      connectable: true,
      docsUrl: "https://github.com/acme/tickets",
    });
  });

  it("lists a stdio-only package as not connectable", () => {
    expect(toRegistryServer(LOCAL)).toMatchObject({
      transports: ["stdio"],
      endpointUrl: null,
      connectable: false,
      auth: "none",
    });
  });

  it("refuses a templated or private endpoint and a deleted entry", () => {
    const templated = toRegistryServer({
      server: {
        name: "com.x/y",
        remotes: [
          { type: "streamable-http", url: "https://{tenant}.x.com/mcp" },
        ],
      },
    });
    expect(templated?.connectable).toBe(false);
    const privateHost = toRegistryServer({
      server: {
        name: "com.x/z",
        remotes: [{ type: "streamable-http", url: "https://127.0.0.1/mcp" }],
      },
    });
    expect(privateHost?.endpointUrl).toBeNull();
    expect(
      toRegistryServer({
        ...ACME,
        _meta: {
          "io.modelcontextprotocol.registry/official": { status: "deleted" },
        },
      }),
    ).toBeNull();
    expect(toRegistryServer({})).toBeNull();
  });
});

describe("searchVerifiedServers", () => {
  it("finds Linear and Slack, with Slack needing the workspace's OAuth app", () => {
    const [linear] = searchVerifiedServers("linear");
    expect(linear).toMatchObject({
      id: "verified/linear",
      endpointUrl: "https://mcp.linear.app/mcp",
      auth: "oauth",
      oauthRegistration: "dynamic",
      publisherVerified: true,
    });
    const [slack] = searchVerifiedServers("slack");
    expect(slack).toMatchObject({
      endpointUrl: "https://mcp.slack.com/mcp",
      oauthRegistration: "client_required",
    });
  });

  it("matches keywords and returns every entry for an empty query", () => {
    expect(searchVerifiedServers("jira").map((s) => s.name)).toEqual([
      "Atlassian",
    ]);
    expect(searchVerifiedServers("").length).toBeGreaterThan(10);
  });
});

describe("searchMcpRegistry", () => {
  beforeEach(() => {
    clearRegistryProbeCacheForTests();
  });

  it("puts verified matches first, drops the registry copy of one, and probes auth", async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (
        url.startsWith("https://registry.modelcontextprotocol.io/v0.1/servers")
      ) {
        expect(new URL(url).searchParams.get("search")).toBe("linear");
        expect(new URL(url).searchParams.get("version")).toBe("latest");
        return json({
          servers: [LINEAR_COPY, ACME, KEYED],
          metadata: { nextCursor: "c2" },
        });
      }
      if (
        url ===
        "https://mcp.acme.example/.well-known/oauth-protected-resource/mcp"
      ) {
        return json({ authorization_servers: ["https://auth.acme.example"] });
      }
      return new Response("", { status: 404 });
    });
    const out = await searchMcpRegistry(
      { query: "linear", limit: 20 },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(out.registryReachable).toBe(true);
    expect(out.nextCursor).toBe("c2");
    expect(out.servers.map((s) => s.id)).toEqual([
      "verified/linear",
      "com.acme/tickets",
      "io.github.someone/keyed",
    ]);
    expect(out.servers[1]).toMatchObject({
      auth: "oauth",
      oauthRegistration: "unknown",
    });
    expect(out.servers[2]).toMatchObject({
      auth: "header",
      authHeader: "X-Api-Key",
    });
  });

  it("answers with the verified entries when the registry cannot be read", async () => {
    const fetchFn = vi.fn(async () => new Response("down", { status: 503 }));
    const out = await searchMcpRegistry(
      { query: "slack", limit: 20 },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(out.registryReachable).toBe(false);
    expect(out.nextCursor).toBeNull();
    expect(out.servers.map((s) => s.id)).toEqual(["verified/slack"]);
  });

  it("lists no verified entries on a later page", async () => {
    const fetchFn = vi.fn(async () => json({ servers: [], metadata: {} }));
    const out = await searchMcpRegistry(
      { query: "linear", cursor: "c2", limit: 20 },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(out.servers).toEqual([]);
    expect(out.nextCursor).toBeNull();
  });
});
