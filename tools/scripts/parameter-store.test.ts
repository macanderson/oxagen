/**
 * Unit tests for the pure parts of lib/parameter-store.ts. The AWS calls
 * themselves are not run here: CI has no credentials, and a test must not
 * reach Parameter Store.
 */

import { describe, expect, it } from "vitest";
import {
  ADVANCED_TIER_MAX_BYTES,
  leafName,
  parseParameterList,
  putParameterInput,
  STANDARD_TIER_MAX_BYTES,
} from "./lib/parameter-store";

const DEV = "/oxagen/development";

describe("leafName", () => {
  it("strips the prefix from a parameter name", () => {
    expect(leafName(DEV, `${DEV}/DATABASE_URL`)).toBe("DATABASE_URL");
  });

  it("accepts a prefix written with a trailing slash", () => {
    expect(leafName(`${DEV}/`, `${DEV}/DATABASE_URL`)).toBe("DATABASE_URL");
  });

  it("returns nothing for a nested path, as build-env.ts skips one", () => {
    expect(leafName(DEV, `${DEV}/neo4j/password`)).toBeUndefined();
  });

  it("returns nothing for a leaf that is not a variable name", () => {
    expect(leafName(DEV, `${DEV}/not-a-name`)).toBeUndefined();
    expect(leafName(DEV, `${DEV}/1STARTS_WITH_A_DIGIT`)).toBeUndefined();
  });

  it("returns nothing for a parameter outside the prefix", () => {
    expect(leafName(DEV, "/oxagen/production/DATABASE_URL")).toBeUndefined();
    // A sibling path that only starts with the same characters.
    expect(leafName(DEV, "/oxagen/development-old/DATABASE_URL")).toBeUndefined();
  });
});

describe("putParameterInput", () => {
  it("saves a secret as a SecureString and anything else as a String", () => {
    expect(putParameterInput(`${DEV}/A`, "v", true)).toEqual({
      Name: `${DEV}/A`,
      Value: "v",
      Type: "SecureString",
      Overwrite: true,
      Tier: "Standard",
    });
    expect(putParameterInput(`${DEV}/A`, "v", false).Type).toBe("String");
  });

  it("moves to the Advanced tier one byte past the Standard limit", () => {
    expect(
      putParameterInput("/p/A", "x".repeat(STANDARD_TIER_MAX_BYTES), true).Tier,
    ).toBe("Standard");
    expect(
      putParameterInput("/p/A", "x".repeat(STANDARD_TIER_MAX_BYTES + 1), true)
        .Tier,
    ).toBe("Advanced");
  });

  it("counts bytes, not characters", () => {
    // 2049 two-byte characters are 4098 bytes.
    expect(putParameterInput("/p/A", "\u00e9".repeat(2049), true).Tier).toBe(
      "Advanced",
    );
  });

  it("refuses a value no tier holds, naming the parameter and not the value", () => {
    const value = "s".repeat(ADVANCED_TIER_MAX_BYTES + 1);
    expect(() => putParameterInput("/p/HUGE", value, true)).toThrow(/\/p\/HUGE/);
    expect(() => putParameterInput("/p/HUGE", value, true)).toThrow(
      new RegExp(`${ADVANCED_TIER_MAX_BYTES + 1} bytes`),
    );
    expect(() =>
      putParameterInput("/p/A", "s".repeat(ADVANCED_TIER_MAX_BYTES), true),
    ).not.toThrow();
  });
});

describe("parseParameterList", () => {
  it("reads the list the CLI prints", () => {
    const stdout = JSON.stringify([
      { Name: `${DEV}/A`, Value: "one" },
      { Name: `${DEV}/B`, Value: "two" },
    ]);
    expect(parseParameterList(stdout, DEV)).toEqual([
      { Name: `${DEV}/A`, Value: "one" },
      { Name: `${DEV}/B`, Value: "two" },
    ]);
  });

  it("reads empty output and null as no parameters", () => {
    expect(parseParameterList("", DEV)).toEqual([]);
    expect(parseParameterList("  \n", DEV)).toEqual([]);
    expect(parseParameterList("null", DEV)).toEqual([]);
    expect(parseParameterList("[]", DEV)).toEqual([]);
  });

  it("refuses output that is not JSON without repeating it", () => {
    const stdout = "Name=A Value=hunter2";
    expect(() => parseParameterList(stdout, DEV)).toThrow(/not JSON/);
    expect(() => parseParameterList(stdout, DEV)).not.toThrow(/hunter2/);
  });

  it("refuses a shape that is not a list of parameters", () => {
    expect(() => parseParameterList('{"Parameters":[]}', DEV)).toThrow(
      /not a list/,
    );
    const missingValue = JSON.stringify([{ Name: `${DEV}/A`, Secret: "hunter2" }]);
    expect(() => parseParameterList(missingValue, DEV)).toThrow(
      /without a string Name and Value/,
    );
    expect(() => parseParameterList(missingValue, DEV)).not.toThrow(/hunter2/);
  });
});
