import { describe, expect, it } from "vitest";
import { pluginSchemaValidate } from "./plugin.schema.validate";
import { getCapability } from "../registry";

describe("plugin.schema.validate capability", () => {
  // ── input schema ──────────────────────────────────────────────────────────

  it("accepts a minimal valid input with pluginId and config", () => {
    const parsed = pluginSchemaValidate.input.parse({
      pluginId: "github",
      config: { token: "ghp_abc123" },
    });
    expect(parsed.pluginId).toBe("github");
    expect(parsed.config).toEqual({ token: "ghp_abc123" });
  });

  it("leaves authSchemeId undefined when not provided", () => {
    const parsed = pluginSchemaValidate.input.parse({
      pluginId: "github",
      config: {},
    });
    expect(parsed.authSchemeId).toBeUndefined();
  });

  it("accepts authSchemeId when provided", () => {
    const parsed = pluginSchemaValidate.input.parse({
      pluginId: "github",
      authSchemeId: "pat",
      config: { token: "ghp_abc123" },
    });
    expect(parsed.authSchemeId).toBe("pat");
  });

  it("accepts an empty config object", () => {
    const parsed = pluginSchemaValidate.input.parse({
      pluginId: "github",
      config: {},
    });
    expect(parsed.config).toEqual({});
  });

  it("accepts config with mixed unknown value types", () => {
    const parsed = pluginSchemaValidate.input.parse({
      pluginId: "github",
      config: {
        token: "ghp_abc",
        orgs: ["my-org"],
        maxItems: 100,
        enabled: true,
      },
    });
    expect(parsed.config["orgs"]).toEqual(["my-org"]);
  });

  it("rejects input missing pluginId", () => {
    expect(() => pluginSchemaValidate.input.parse({ config: {} })).toThrow();
  });

  it("rejects input missing config", () => {
    expect(() =>
      pluginSchemaValidate.input.parse({ pluginId: "github" }),
    ).toThrow();
  });

  it("rejects non-string pluginId", () => {
    expect(() =>
      pluginSchemaValidate.input.parse({ pluginId: 99, config: {} }),
    ).toThrow();
  });

  // ── output schema: valid cases ────────────────────────────────────────────

  it("parses a valid=true output with an empty errors array", () => {
    const parsed = pluginSchemaValidate.output.parse({
      valid: true,
      errors: [],
    });
    expect(parsed.valid).toBe(true);
    expect(parsed.errors).toHaveLength(0);
  });

  it("parses a valid=false output with field errors", () => {
    const parsed = pluginSchemaValidate.output.parse({
      valid: false,
      errors: [
        {
          field: "config.token",
          message: "Token is required",
          code: "required",
        },
      ],
    });
    expect(parsed.valid).toBe(false);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]?.field).toBe("config.token");
    expect(parsed.errors[0]?.code).toBe("required");
  });

  it("parses output with multiple field errors", () => {
    const parsed = pluginSchemaValidate.output.parse({
      valid: false,
      errors: [
        { field: "config.token", message: "Required", code: "required" },
        { field: "config.orgs", message: "Too few items", code: "minItems" },
        { field: "config.url", message: "Invalid pattern", code: "pattern" },
      ],
    });
    expect(parsed.errors).toHaveLength(3);
    expect(parsed.errors[1]?.code).toBe("minItems");
  });

  // ── output schema: error code enum ───────────────────────────────────────

  it("accepts all valid error code values", () => {
    const codes = [
      "required",
      "min",
      "max",
      "minItems",
      "maxItems",
      "pattern",
      "itemPattern",
      "oneOf",
      "type",
      "unknown",
    ] as const;
    for (const code of codes) {
      const parsed = pluginSchemaValidate.output.parse({
        valid: false,
        errors: [{ field: "f", message: "err", code }],
      });
      expect(parsed.errors[0]?.code).toBe(code);
    }
  });

  it("rejects an unknown error code", () => {
    expect(() =>
      pluginSchemaValidate.output.parse({
        valid: false,
        errors: [{ field: "f", message: "err", code: "invalid_enum" }],
      }),
    ).toThrow();
  });

  // ── output schema: invalid cases ─────────────────────────────────────────

  it("rejects output missing the valid field", () => {
    expect(() => pluginSchemaValidate.output.parse({ errors: [] })).toThrow();
  });

  it("rejects output missing the errors array", () => {
    expect(() => pluginSchemaValidate.output.parse({ valid: true })).toThrow();
  });

  it("rejects output where errors is not an array", () => {
    expect(() =>
      pluginSchemaValidate.output.parse({ valid: false, errors: "none" }),
    ).toThrow();
  });

  it("rejects an error entry missing field", () => {
    expect(() =>
      pluginSchemaValidate.output.parse({
        valid: false,
        errors: [{ message: "err", code: "required" }],
      }),
    ).toThrow();
  });

  it("rejects an error entry missing message", () => {
    expect(() =>
      pluginSchemaValidate.output.parse({
        valid: false,
        errors: [{ field: "f", code: "required" }],
      }),
    ).toThrow();
  });

  it("rejects an error entry missing code", () => {
    expect(() =>
      pluginSchemaValidate.output.parse({
        valid: false,
        errors: [{ field: "f", message: "err" }],
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("validate_plugin_schema")).toBe(pluginSchemaValidate);
  });
});
