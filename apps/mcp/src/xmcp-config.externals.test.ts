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
  entry?: Record<string, string>;
  output?: Record<string, unknown>;
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
  const heavy = ["pdf-lib", "inngest", "neo4j-driver", "stripe", "better-auth", "@cedar-policy/cedar-wasm"];

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

  it("resolves tests and `_` helpers under src/tools to an empty module", () => {
    // xmcp registers every file under src/tools as a tool. The import map asks
    // for each one as `../src/tools/<file>`. An empty module is skipped.
    expect(runExternal("../src/tools/agent.handlers.test.ts")).toBe("var {}");
    expect(runExternal("../src/tools/tool-registry.test.ts")).toBe("var {}");
    expect(runExternal("../src/tools/_schema-test-helpers.ts")).toBe("var {}");
    expect(runExternal("/app/src/tools/nested/x.test.tsx")).toBe("var {}");
  });

  it("keeps every real tool in the bundle", () => {
    expect(runExternal("../src/tools/agent.memory.write.ts")).toBe(undefined);
    expect(runExternal("../src/tools/tool.studio.listing.get.ts")).toBe(undefined);
    // A test outside src/tools is not the tool loader's concern.
    expect(runExternal("./context.test.ts")).toBe(undefined);
  });

  it("builds one bundle so the tools share one copy of their dependencies", () => {
    // Per-tool chunks with splitChunks off came to 2.6 GB, and the first
    // request loaded them all (#4829).
    const bundler = xmcpConfig.bundler as (
      c: FakeBundlerConfig,
    ) => FakeBundlerConfig;
    const out = bundler({ output: { path: "/dist", filename: "[name].js" } });
    expect(out.output).toEqual({ path: "/dist", filename: "[name].js", asyncChunks: false });
  });

  it("leaves xmcp's own HTTP entry in place", () => {
    // The owned edge in src/http-app.ts stays unwired until a test drives a
    // real POST /mcp through it with the real middleware (#4202).
    const bundler = xmcpConfig.bundler as (
      c: FakeBundlerConfig,
    ) => FakeBundlerConfig;
    const out = bundler({ entry: { http: "/xmcp/runtime/http.js" } });
    expect(out.entry).toEqual({ http: "/xmcp/runtime/http.js" });
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
