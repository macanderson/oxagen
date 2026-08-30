import { describe, it, expect } from "vitest";
import xmcpConfig from "../xmcp.config";

/**
 * Guards the xmcp production build against re-bundling the native duckdb chain.
 *
 * rspack cannot statically bundle the `duckdb` addon or its
 * `@mapbox/node-pre-gyp` -> `node-gyp` toolchain: that toolchain ships
 * C#/HTML/`s3_setup.js` assets rspack cannot parse, and it dynamically
 * require()s aws-sdk / mock-aws-s3 / nock. duckdb reaches this build
 * transitively:
 *   src/middleware.ts -> @oxagen/agent register/handlers
 *   -> agent.trace.get.ts -> @oxagen/engram barrel
 *   -> store/index.ts -> store/duckdb-adapter.ts.
 * So the bundler config externalizes the whole chain and it resolves from
 * node_modules at runtime. Dropping any entry below breaks `xmcp build` with
 * `Module parse failed` / `Module not found`, which this test catches first.
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

describe("xmcp bundler externals — native duckdb chain", () => {
  // Every package in the duckdb native-addon chain that rspack cannot bundle.
  const nativeChain = [
    "duckdb",
    "@mapbox/node-pre-gyp",
    "node-gyp",
    "mock-aws-s3",
    "aws-sdk",
    "nock",
  ];

  for (const pkg of nativeChain) {
    it(`externalizes ${pkg} as a runtime commonjs require`, () => {
      expect(runExternal(pkg)).toBe(`commonjs ${pkg}`);
    });

    it(`externalizes sub-path imports of ${pkg}`, () => {
      expect(runExternal(`${pkg}/lib/binding`)).toBe(
        `commonjs ${pkg}/lib/binding`,
      );
    });
  }

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
    // not be caught (word-boundary check on `duckdb` vs `duckdbx`).
    expect(runExternal("duckdbx")).toBe(undefined);
  });
});
