import { describe, expect, it } from "vitest";
import { secretKeyUpsert } from "./secret.key.upsert";

describe("secret.key.upsert contract", () => {
  it("registers with the correct name", () => {
    expect(secretKeyUpsert.name).toBe("upsert_secret_key");
  });
  it("exposes the api, mcp, and agent surfaces", () => {
    expect(secretKeyUpsert.surfaces).toEqual(["api", "mcp", "agent"]);
  });
  it("accepts a valid input", () => {
    expect(() => secretKeyUpsert.input.parse({ key: "API_KEY" })).not.toThrow();
  });
  it("defaults `sensitive` to true", () => {
    const parsed = secretKeyUpsert.input.parse({ key: "API_KEY" });
    expect(parsed.sensitive).toBe(true);
  });
  it("honours an explicit sensitive=false", () => {
    expect(
      secretKeyUpsert.input.parse({ key: "LOG_LEVEL", sensitive: false })
        .sensitive,
    ).toBe(false);
  });
  it("rejects input missing the required key", () => {
    expect(() => secretKeyUpsert.input.parse({})).toThrow();
  });
  it("accepts a valid output", () => {
    expect(() => secretKeyUpsert.output.parse({ id: "sk_1" })).not.toThrow();
  });
});
