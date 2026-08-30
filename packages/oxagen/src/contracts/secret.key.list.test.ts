import { describe, expect, it } from "vitest";
import { secretKeyList } from "./secret.key.list";

const keySummary = {
  id: "sk_1",
  key: "API_KEY",
  sensitive: true,
  memo: null,
  hasDefault: true,
  overrideEnvironmentIds: ["env_1", "env_2"],
};

describe("secret.key.list contract", () => {
  it("registers with the correct name", () => {
    expect(secretKeyList.name).toBe("list_secret_keys");
  });
  it("exposes the api, mcp, and agent surfaces", () => {
    expect(secretKeyList.surfaces).toEqual(["api", "mcp", "agent"]);
  });
  it("accepts an empty input object", () => {
    expect(() => secretKeyList.input.parse({})).not.toThrow();
  });
  it("rejects a non-object input", () => {
    expect(() => secretKeyList.input.parse(null)).toThrow();
  });
  it("accepts a valid output", () => {
    expect(() =>
      secretKeyList.output.parse({ keys: [keySummary] }),
    ).not.toThrow();
    expect(() => secretKeyList.output.parse({ keys: [] })).not.toThrow();
  });
});
