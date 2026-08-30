import { describe, expect, it } from "vitest";
import { codeFormat } from "./code.format";
import { getCapability } from "../registry";

describe("code.format capability", () => {
  it("accepts language='json'", () => {
    const parsed = codeFormat.input.parse({ language: "json", source: "{}" });
    expect(parsed.language).toBe("json");
  });

  it("accepts language='python'", () => {
    const parsed = codeFormat.input.parse({
      language: "python",
      source: "x=1",
    });
    expect(parsed.language).toBe("python");
  });

  it("rejects an unsupported language", () => {
    expect(() =>
      codeFormat.input.parse({ language: "rust", source: "fn main(){}" }),
    ).toThrow();
  });

  it("defaults indent to 2", () => {
    const parsed = codeFormat.input.parse({ language: "json", source: "{}" });
    expect(parsed.indent).toBe(2);
  });

  it("accepts an explicit indent", () => {
    const parsed = codeFormat.input.parse({
      language: "json",
      source: "{}",
      indent: 4,
    });
    expect(parsed.indent).toBe(4);
  });

  it("rejects an indent above the max", () => {
    expect(() =>
      codeFormat.input.parse({ language: "json", source: "{}", indent: 9 }),
    ).toThrow();
  });

  it("rejects an empty source", () => {
    expect(() =>
      codeFormat.input.parse({ language: "json", source: "" }),
    ).toThrow();
  });

  it("rejects an over-large source", () => {
    const huge = "x".repeat(1024 * 1024 + 1);
    expect(() =>
      codeFormat.input.parse({ language: "python", source: huge }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = codeFormat.output.parse({
      formatted: '{\n  "a": 1\n}',
      changed: true,
      language: "json",
    });
    expect(parsed.changed).toBe(true);
    expect(parsed.language).toBe("json");
  });

  it("rejects an output with an unknown language", () => {
    expect(() =>
      codeFormat.output.parse({
        formatted: "x",
        changed: false,
        language: "rust",
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("format_code")).toBe(codeFormat);
  });

  it("declares the api, mcp, and agent surfaces", () => {
    expect(codeFormat.surfaces).toEqual(["api", "mcp", "agent"]);
  });
});
