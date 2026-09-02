import { describe, expect, it } from "vitest";
import {
  deriveTransportTypes,
  deriveAuthKind,
  mapServerDetailToCatalogRow,
} from "./map-server";
import type { ServerDetail, ServerMeta } from "./types";

const REGISTRY_ID = "11111111-1111-1111-1111-111111111111";

describe("deriveTransportTypes", () => {
  it("collects distinct transport types from packages + remotes", () => {
    const sd: ServerDetail = {
      name: "io.x/a",
      description: "d",
      version: "1.0.0",
      packages: [
        { registryType: "npm", identifier: "a", transport: { type: "stdio" } },
      ],
      remotes: [
        { type: "streamable-http", url: "https://x" },
        { type: "sse", url: "https://y" },
      ],
    };
    expect(deriveTransportTypes(sd).sort()).toEqual([
      "sse",
      "stdio",
      "streamable-http",
    ]);
  });
});

describe("deriveAuthKind", () => {
  it("returns 'none' when nothing is secret", () => {
    const sd: ServerDetail = {
      name: "io.x/a",
      description: "d",
      version: "1.0.0",
      remotes: [{ type: "sse", url: "https://x" }],
    };
    expect(deriveAuthKind(sd)).toBe("none");
  });
  it("returns 'secret' when a remote variable is secret", () => {
    const sd: ServerDetail = {
      name: "io.x/a",
      description: "d",
      version: "1.0.0",
      remotes: [
        {
          type: "streamable-http",
          url: "https://x",
          variables: { API_KEY: { isSecret: true } },
        },
      ],
    };
    expect(deriveAuthKind(sd)).toBe("secret");
  });
  it("returns 'secret' when a package env var is secret", () => {
    const sd: ServerDetail = {
      name: "io.x/a",
      description: "d",
      version: "1.0.0",
      packages: [
        {
          registryType: "npm",
          identifier: "a",
          transport: { type: "stdio" },
          environmentVariables: [{ name: "TOKEN", isSecret: true }],
        },
      ],
    };
    expect(deriveAuthKind(sd)).toBe("secret");
  });
});

describe("mapServerDetailToCatalogRow", () => {
  it("maps a ServerDetail + meta into catalog columns", () => {
    const sd: ServerDetail = {
      name: "io.x/weather",
      description: "Weather",
      version: "1.2.3",
      title: "Weather",
      repository: { url: "https://github.com/x/weather", source: "github" },
      icons: [{ src: "https://x/i.png" }],
      remotes: [
        {
          type: "streamable-http",
          url: "https://api/mcp",
          variables: { K: { isSecret: true } },
        },
      ],
    };
    const meta: ServerMeta = {
      status: "active",
      isLatest: true,
      publishedAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
    };
    const row = mapServerDetailToCatalogRow(sd, meta, REGISTRY_ID);
    expect(row.registryId).toBe(REGISTRY_ID);
    expect(row.name).toBe("io.x/weather");
    expect(row.version).toBe("1.2.3");
    expect(row.isLatest).toBe(true);
    expect(row.status).toBe("active");
    expect(row.authKind).toBe("secret");
    expect(row.transportTypes).toEqual(["streamable-http"]);
    expect(row.upstreamUpdatedAt).toBeInstanceOf(Date);
  });
  it("defaults status to active and isLatest to false when meta is absent", () => {
    const sd: ServerDetail = {
      name: "io.x/a",
      description: "d",
      version: "1.0.0",
    };
    const row = mapServerDetailToCatalogRow(sd, undefined, REGISTRY_ID);
    expect(row.status).toBe("active");
    expect(row.isLatest).toBe(false);
    expect(row.authKind).toBe("none");
  });
});
