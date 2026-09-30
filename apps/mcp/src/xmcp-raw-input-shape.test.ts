import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import rawInputShape from "../xmcp-raw-input-shape.cjs";
import xmcpConfig from "../xmcp.config";

/**
 * Guards the loader that hands each tool's raw input shape to the MCP SDK.
 * Without it, xmcp wraps Oxagen's zod v3 fields in a zod v4 object and
 * tools/list fails on every tool (#4829).
 */

const runtimeFile = (name: string): string =>
  fileURLToPath(new URL(`../node_modules/xmcp/dist/runtime/${name}`, import.meta.url));

describe("xmcp-raw-input-shape loader", () => {
  it("replaces the wrapped input schema with the raw shape", () => {
    const source = 'let g={title:t,inputSchema:nz(u),outputSchema:i?nz(i).strict():void 0};';
    expect(rawInputShape(source)).toBe(
      'let g={title:t,inputSchema:u,outputSchema:i?nz(i).strict():void 0};',
    );
  });

  it("fails the build when the runtime holds no wrapper to replace", () => {
    expect(() => rawInputShape("let g={inputSchema:u,};")).toThrow(/found 0/);
  });

  it("fails the build when the runtime holds more than one", () => {
    expect(() => rawInputShape("inputSchema:nz(u),inputSchema:ab(u),")).toThrow(/found 2/);
  });

  it("finds exactly one wrapper in each pinned runtime it is wired to", () => {
    for (const name of ["http.js", "adapter-express.js"]) {
      const out = rawInputShape(readFileSync(runtimeFile(name), "utf8"));
      expect(out, name).toContain("inputSchema:u,");
    }
  });
});

describe("xmcp config wiring", () => {
  interface Rule {
    test?: RegExp;
    loader?: string;
  }
  const bundler = xmcpConfig.bundler as (c: { module?: { rules?: unknown[] } }) => {
    module?: { rules?: unknown[] };
  };

  it("runs the loader on xmcp's HTTP and Express runtimes only", () => {
    const rules = (bundler({ module: { rules: [{ test: /\.ts$/ }] } }).module?.rules ?? []) as Rule[];
    const rule = rules.find((r) => r.loader?.endsWith("/xmcp-raw-input-shape.cjs"));
    expect(rule, "the loader is wired").toBeDefined();
    expect(rules[0]).toEqual({ test: /\.ts$/ });

    const matches = (path: string): boolean => rule?.test?.test(path) ?? false;
    expect(matches("/n/.pnpm/xmcp@0.6.13_x/node_modules/xmcp/dist/runtime/http.js")).toBe(true);
    expect(matches("/n/node_modules/xmcp/dist/runtime/adapter-express.js")).toBe(true);
    expect(matches("/n/node_modules/xmcp/dist/runtime/stdio.js")).toBe(false);
    expect(matches("/app/src/http.js")).toBe(false);
  });
});
