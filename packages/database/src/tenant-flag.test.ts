// tenant-flag.test.ts
//
// Unit tests for rlsEnforced() from @oxagen/database/tenant-flag.
//
// The function reads TENANT_RLS_ENFORCEMENT_ENABLED through requireEnv, which
// applies the Zod schema transform: "true" → true, anything else/undefined → false.

import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock requireEnv before any imports so vi.mock hoisting applies.
// We use importOriginal so baseEnvSchema is still accessible for the schema
// parity tests at the bottom of this file.
// ---------------------------------------------------------------------------

const requireEnvMock = vi.hoisted(() =>
  vi.fn(
    (
      _keys: readonly string[],
    ): { TENANT_RLS_ENFORCEMENT_ENABLED: boolean } => ({
      TENANT_RLS_ENFORCEMENT_ENABLED: false,
    }),
  ),
);

vi.mock("@oxagen/config/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oxagen/config/env")>();
  return {
    ...actual,
    requireEnv: requireEnvMock,
  };
});

// Import AFTER the mock is set up.
import { rlsEnforced } from "./tenant-flag";

beforeEach(() => {
  requireEnvMock.mockClear();
});

describe("rlsEnforced", () => {
  it("returns true when requireEnv returns true (mirrors 'true' string transform)", () => {
    requireEnvMock.mockReturnValueOnce({
      TENANT_RLS_ENFORCEMENT_ENABLED: true,
    });
    expect(rlsEnforced()).toBe(true);
  });

  it("returns false when requireEnv returns false (mirrors undefined/missing transform)", () => {
    requireEnvMock.mockReturnValueOnce({
      TENANT_RLS_ENFORCEMENT_ENABLED: false,
    });
    expect(rlsEnforced()).toBe(false);
  });

  it("returns false by default (mock default → false)", () => {
    // The mock default value is false — confirms the function delegates to
    // requireEnv rather than hard-coding a value.
    expect(rlsEnforced()).toBe(false);
  });

  it("invokes requireEnv with the TENANT_RLS_ENFORCEMENT_ENABLED key", () => {
    rlsEnforced();
    expect(requireEnvMock).toHaveBeenCalledWith(
      expect.arrayContaining(["TENANT_RLS_ENFORCEMENT_ENABLED"]),
    );
  });

  it("returns a boolean (not a string, not undefined)", () => {
    requireEnvMock.mockReturnValueOnce({
      TENANT_RLS_ENFORCEMENT_ENABLED: true,
    });
    expect(rlsEnforced()).toBeTypeOf("boolean");

    requireEnvMock.mockReturnValueOnce({
      TENANT_RLS_ENFORCEMENT_ENABLED: false,
    });
    expect(rlsEnforced()).toBeTypeOf("boolean");
  });
});

// ---------------------------------------------------------------------------
// Zod schema transform parity (via the real schema, not the mock)
// ---------------------------------------------------------------------------

describe("TENANT_RLS_ENFORCEMENT_ENABLED Zod transform parity", () => {
  // Import the schema directly to verify the transform matches what rlsEnforced
  // depends on. This asserts the contract between the schema and the function
  // without needing to call requireEnv with a real process.env.
  it("schema transforms 'true' to boolean true", async () => {
    const { baseEnvSchema } = await import("@oxagen/config/env");
    const field = baseEnvSchema.shape.TENANT_RLS_ENFORCEMENT_ENABLED;
    // The field is optional with transform; parse the string "true"
    const result = field.parse("true");
    expect(result).toBe(true);
  });

  it("schema transforms 'false' to boolean false", async () => {
    const { baseEnvSchema } = await import("@oxagen/config/env");
    const field = baseEnvSchema.shape.TENANT_RLS_ENFORCEMENT_ENABLED;
    const result = field.parse("false");
    expect(result).toBe(false);
  });

  it("schema transforms undefined to false in a non-production runtime (seeding window)", async () => {
    // Vitest runs with NODE_ENV=test and no VERCEL_ENV → not production → off.
    const { baseEnvSchema } = await import("@oxagen/config/env");
    const field = baseEnvSchema.shape.TENANT_RLS_ENFORCEMENT_ENABLED;
    const result = field.parse(undefined);
    expect(result).toBe(false);
  });

  it("schema transforms undefined to TRUE in a production runtime (fail-closed)", async () => {
    const savedVercel = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = "production";
    try {
      const { baseEnvSchema } = await import("@oxagen/config/env");
      const field = baseEnvSchema.shape.TENANT_RLS_ENFORCEMENT_ENABLED;
      expect(field.parse(undefined)).toBe(true);
    } finally {
      if (savedVercel === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = savedVercel;
    }
  });

  it("schema rejects non-'true'/'false' strings", async () => {
    const { baseEnvSchema } = await import("@oxagen/config/env");
    const field = baseEnvSchema.shape.TENANT_RLS_ENFORCEMENT_ENABLED;
    expect(() => field.parse("yes")).toThrow();
    expect(() => field.parse("1")).toThrow();
    expect(() => field.parse("True")).toThrow();
  });
});
