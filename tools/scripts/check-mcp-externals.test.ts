import { describe, expect, it } from "vitest";
import { externalsFrom, undeclared } from "./check-mcp-externals";

const CONFIG = `
  const heavy: string[] = [
    "duckdb",
    "@mapbox/node-pre-gyp",
    "drizzle-orm",
    "postgres",
  ];
`;

describe("externalsFrom", () => {
  it("reads the externals array out of the config source", () => {
    expect(externalsFrom(CONFIG)).toEqual([
      "duckdb",
      "@mapbox/node-pre-gyp",
      "drizzle-orm",
      "postgres",
    ]);
  });

  it("returns nothing when the array is absent rather than throwing", () => {
    expect(externalsFrom("const config = {};")).toEqual([]);
  });
});

describe("undeclared", () => {
  it("catches the #1191 state — externalised, never declared", () => {
    // apps/mcp declared xmcp and zod and nothing else, which produced a deploy
    // tree of three packages and `Cannot find module 'drizzle-orm/postgres-js'`.
    const missing = undeclared(externalsFrom(CONFIG), { xmcp: "1", zod: "3" });
    expect(missing).toContain("drizzle-orm");
    expect(missing).toContain("postgres");
    expect(missing).toContain("duckdb");
  });

  it("passes once they are declared", () => {
    const missing = undeclared(externalsFrom(CONFIG), {
      duckdb: "1.3.0",
      "drizzle-orm": "0.45.2",
      postgres: "3.4.9",
    });
    expect(missing).toEqual([]);
  });

  it("does not demand duckdb's native toolchain be declared separately", () => {
    // @mapbox/node-pre-gyp and friends arrive with duckdb; requiring explicit
    // entries for them would be noise rather than a guard.
    const missing = undeclared(
      ["@mapbox/node-pre-gyp", "node-gyp", "aws-sdk"],
      {},
    );
    expect(missing).toEqual([]);
  });
});
