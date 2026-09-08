import { describe, expect, it } from "vitest";
import {
  externalisedPackages,
  undeclared,
  NOT_RESOLVED_AT_RUNTIME,
} from "./check-mcp-externals-declared.mjs";

const CONFIG = `
  const heavyPackages: string[] = [
    "duckdb",
    "node-gyp",
    "stripe",
  ];
`;

describe("externalisedPackages", () => {
  it("reads the names out of the config", () => {
    expect(externalisedPackages(CONFIG)).toEqual([
      "duckdb",
      "node-gyp",
      "stripe",
    ]);
  });

  it("returns null when the array is gone, so the caller can refuse", () => {
    // A check that cannot find its subject must not report that its subject is
    // fine.
    expect(externalisedPackages("export default {}")).toBeNull();
  });
});

describe("undeclared (#1304)", () => {
  it("passes when every runtime external is a dependency", () => {
    expect(
      undeclared(["duckdb", "stripe"], { duckdb: "1", stripe: "1" }),
    ).toEqual([]);
  });

  it("fails an externalised package the manifest does not declare", () => {
    // The exact shape of #1304: the bundle emits a bare require() and pnpm
    // deploy puts nothing at the top level for it.
    expect(undeclared(["duckdb", "stripe"], { duckdb: "1" })).toEqual([
      "stripe",
    ]);
  });

  it("exempts the five that are externalised only to quiet the bundler", () => {
    expect(undeclared([...NOT_RESOLVED_AT_RUNTIME], {})).toEqual([]);
  });

  it("does not exempt a package merely because it is native", () => {
    // duckdb IS resolved at runtime and must stay declared, unlike the
    // node-pre-gyp branches it drags in.
    expect(NOT_RESOLVED_AT_RUNTIME.has("duckdb")).toBe(false);
    expect(undeclared(["duckdb"], {})).toEqual(["duckdb"]);
  });
});
