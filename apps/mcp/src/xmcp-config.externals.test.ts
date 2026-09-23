import { describe, it, expect } from "vitest";
import xmcpConfig from "../xmcp.config";

/**
 * Guards the xmcp bundler override: heavy runtime SDKs resolve from
 * node_modules instead of being bundled, xmcp's forced zod alias is stripped,
 * and `.js` imports map back to their TypeScript sources. Dropping an external
 * breaks `xmcp build` or the 250MB function limit, which this test catches
 * first.
 */

interface FakeBundlerConfig {
  resolve?: Record<string, unknown>;
  externals?: unknown;
}

type ExternalFn = (
  data: { request?: string },
  callback: (err?: Error, result?: string) => void,
) => void;

function runExternal(request: string): string | undefined {
  const bundler = xmcpConfig.bundler;
  expect(bundler, "xmcp config must define a bundler override").toBeTypeOf(
    "function",
  );

  const cfg: FakeBundlerConfig = {};
  const out = (bundler as (c: FakeBundlerConfig) => FakeBundlerConfig)(cfg);

  const externals = out.externals;
  expect(Array.isArray(externals)).toBe(true);
  const fn = (externals as unknown[]).find(
    (e): e is ExternalFn => typeof e === "function",
  );
  expect(fn, "bundler must register a function-based external").toBeDefined();

  let result: string | undefined;
  fn!({ request }, (_err, res) => {
    result = res;
  });
  return result;
}

describe("xmcp bundler externals", () => {
  // Heavy SDKs this app loads only at runtime.
  const heavy = ["pdf-lib", "inngest", "neo4j-driver", "stripe", "better-auth"];

  for (const pkg of heavy) {
    it(`externalizes ${pkg} as a runtime commonjs require`, () => {
      expect(runExternal(pkg)).toBe(`commonjs ${pkg}`);
    });

    it(`externalizes sub-path imports of ${pkg}`, () => {
      expect(runExternal(`${pkg}/lib/index`)).toBe(`commonjs ${pkg}/lib/index`);
    });
  }

  it("no longer externalizes duckdb or its node-pre-gyp chain (ADR-144)", () => {
    expect(runExternal("duckdb")).toBe(undefined);
    expect(runExternal("@mapbox/node-pre-gyp")).toBe(undefined);
  });

  it("strips xmcp's forced zod alias so better-auth can resolve zod v4", () => {
    // xmcp pins `zod`, `zod/v3` and `zod/v4-mini` to this app's zod v3.
    // better-auth's dist imports v4-only APIs (z.looseObject), so the forced
    // alias breaks `xmcp build`. The bundler override deletes those three keys
    // and leaves every other alias alone.
    const bundler = xmcpConfig.bundler as (
      c: FakeBundlerConfig,
    ) => FakeBundlerConfig;
    const out = bundler({
      resolve: {
        alias: {
          zod: "/pinned/zod",
          "zod/v3": "/pinned/zod/v3",
          "zod/v4-mini": "/pinned/zod/v4-mini",
          "@oxagen/oxagen": "/workspace/oxagen",
        },
      },
    });

    const alias = out.resolve?.alias as Record<string, unknown>;
    expect(alias).not.toHaveProperty("zod");
    expect(alias).not.toHaveProperty("zod/v3");
    expect(alias).not.toHaveProperty("zod/v4-mini");
    expect(alias["@oxagen/oxagen"]).toBe("/workspace/oxagen");
  });

  it("maps .js/.mjs/.cjs imports back to their TypeScript sources", () => {
    // Workspace packages compiled with verbatimModuleSyntax emit `./x.js`
    // relative imports whose source is `./x.ts`; without extensionAlias rspack
    // reports Module not found for every one of them.
    const bundler = xmcpConfig.bundler as (
      c: FakeBundlerConfig,
    ) => FakeBundlerConfig;
    const out = bundler({});
    expect(out.resolve?.extensionAlias).toEqual({
      ".js": [".ts", ".js"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    });
  });

  it("does NOT externalize unrelated app/workspace modules", () => {
    // Contract types must stay bundled — externalizing them would break the
    // build differently. Guards against an over-broad matcher.
    expect(runExternal("@oxagen/oxagen/contracts/agent.trace.get")).toBe(
      undefined,
    );
    expect(runExternal("./context")).toBe(undefined);
    // A package whose name merely starts with a heavy prefix's letters must
    // not be caught (word-boundary check on `ai` vs `aiohttp`, `stripe` vs
    // `striped`).
    expect(runExternal("aiohttp")).toBe(undefined);
    expect(runExternal("striped")).toBe(undefined);
  });
});
