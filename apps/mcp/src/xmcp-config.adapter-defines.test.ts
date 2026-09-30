import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createRequestAdmission } from "@oxagen/telemetry/request-admission";
import xmcpConfig, { EXPRESS_ADAPTER_DEFINES } from "../xmcp.config";
import { createMcpHttpApp } from "./http-app";

/**
 * Guards the constants the owned HTTP edge's adapter reads as bare globals.
 * A missing one throws a ReferenceError when the bundle starts, which no build
 * step catches and which rolled production back on 2026-09-30 (#4829).
 */

/** Stands in for the DefinePlugin xmcp adds before it calls the hook. */
class DefinePlugin {
  name = "DefinePlugin";
  constructor(readonly definitions: Record<string, string>) {}
}

interface FakeBundlerConfig {
  plugins?: unknown[];
}

const bundler = xmcpConfig.bundler as (c: FakeBundlerConfig) => FakeBundlerConfig;

/** The names xmcp 0.6.13's compiler defines for every HTTP build. */
const XMCP_DEFINED = new Set(["HTTP_CONFIG", "HTTP_CORS_CONFIG"]);

const adapterSource = readFileSync(
  fileURLToPath(new URL("../node_modules/xmcp/dist/runtime/adapter-express.js", import.meta.url)),
  "utf8",
);

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

describe("xmcp Express adapter defines", () => {
  it("adds a DefinePlugin of xmcp's own class carrying the adapter constants", () => {
    const xmcpDefine = new DefinePlugin({ HTTP_CONFIG: "{}" });
    const out = bundler({ plugins: [xmcpDefine] });

    expect(out.plugins).toHaveLength(2);
    expect(out.plugins?.[0]).toBe(xmcpDefine);
    const added = out.plugins?.[1];
    expect(added).toBeInstanceOf(DefinePlugin);
    expect((added as DefinePlugin).definitions).toEqual(EXPRESS_ADAPTER_DEFINES);
  });

  it("fails the build when xmcp added no DefinePlugin to reuse", () => {
    expect(() => bundler({})).toThrow(/no DefinePlugin/);
  });

  it("defines every bare HTTP_* global the pinned adapter reads", () => {
    const read = new Set(adapterSource.match(/(?<![\w.$'"])HTTP_[A-Z_]+\b/g) ?? []);
    expect(read).toContain("HTTP_CORS_ORIGIN");

    const undefinedNames = [...read].filter(
      (name) => !XMCP_DEFINED.has(name) && !(name in EXPRESS_ADAPTER_DEFINES),
    );
    expect(undefinedNames).toEqual([]);
  });

  it("gives every define a JSON value rspack can inline", () => {
    for (const [name, value] of Object.entries(EXPRESS_ADAPTER_DEFINES)) {
      expect(() => JSON.parse(value) as unknown, name).not.toThrow();
    }
  });

  it("sets the same CORS headers the edge sends, so the adapter does not rewrite them", async () => {
    const admission = createRequestAdmission({
      control: { concurrency: 1, reserveBytes: 1 },
      tool: { concurrency: 1, reserveBytes: 1 },
    }, () => ({ heapUsed: 0, heapLimit: 1_000, rss: 0, memoryLimit: 1_000 }));
    const server = createServer(createMcpHttpApp([], () => undefined, admission));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${String(port)}/mcp`, { method: "OPTIONS" });

    // The adapter joins arrays with commas and stringifies the rest.
    const header = (name: string): string => {
      const value = JSON.parse(EXPRESS_ADAPTER_DEFINES[name] ?? "null") as unknown;
      return Array.isArray(value) ? value.join(",") : String(value);
    };
    expect(response.headers.get("access-control-allow-origin")).toBe(header("HTTP_CORS_ORIGIN"));
    expect(response.headers.get("access-control-allow-methods")).toBe(header("HTTP_CORS_METHODS"));
    expect(response.headers.get("access-control-allow-headers")).toBe(header("HTTP_CORS_ALLOWED_HEADERS"));
    expect(response.headers.get("access-control-expose-headers")).toBe(header("HTTP_CORS_EXPOSED_HEADERS"));
    expect(response.headers.get("access-control-allow-credentials")).toBe(header("HTTP_CORS_CREDENTIALS"));
    expect(response.headers.get("access-control-max-age")).toBe(header("HTTP_CORS_MAX_AGE"));
  });
});
