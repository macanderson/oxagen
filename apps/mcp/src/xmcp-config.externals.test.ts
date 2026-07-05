import { describe, it, expect } from "vitest";
import xmcpConfig from "../xmcp.config";

/**
 * Regression guard for the xmcp production build.
 *
 * OXA — `@oxagen/mcp` build failed with rspack `Module parse failed` /
 * `Module not found` errors while trying to statically bundle the native
 * `duckdb` addon and its `@mapbox/node-pre-gyp` -> `node-gyp` toolchain
 * (which ships C#/HTML/`s3_setup.js` assets and dynamically require()s
 * aws-sdk / mock-aws-s3 / nock). duckdb is dragged in transitively:
 *   src/middleware.ts -> @oxagen/agent register/handlers
 *   -> agent.trace.get.ts -> @oxagen/engram barrel -> store/graph-store.ts.
 * The fix externalizes the whole native chain in the bundler config so it
 * resolves from node_modules at runtime instead of being bundled. This test
 * fails on the old config (duckdb absent from externals) and passes now.
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
    "blake3",
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
