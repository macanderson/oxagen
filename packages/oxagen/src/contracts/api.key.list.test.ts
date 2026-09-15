import { describe, expect, it } from "vitest";
import { z } from "zod";
import { apiKeyList } from "./api.key.list";
import { apiKeyCreate } from "./api.key.create";
import { getCapability } from "../registry";

/**
 * Every object key reachable from a zod schema, through arrays, nullables,
 * optionals and nested objects. Written against the zod 3 `_def` shape this
 * package pins; a schema kind it does not know is a test failure rather than
 * an unwalked branch.
 */
function fieldNames(schema: z.ZodTypeAny, path = ""): string[] {
  if (schema instanceof z.ZodObject) {
    return Object.entries(schema.shape).flatMap(([key, child]) => [
      path ? `${path}.${key}` : key,
      ...fieldNames(child as z.ZodTypeAny, path ? `${path}.${key}` : key),
    ]);
  }
  if (schema instanceof z.ZodArray) return fieldNames(schema.element, path);
  if (schema instanceof z.ZodNullable || schema instanceof z.ZodOptional)
    return fieldNames(schema.unwrap(), path);
  if (schema instanceof z.ZodRecord)
    return fieldNames(schema.valueSchema, path);
  if (
    schema instanceof z.ZodString ||
    schema instanceof z.ZodBoolean ||
    schema instanceof z.ZodUnknown
  )
    return [];
  throw new Error(`fieldNames: unhandled schema kind at "${path}"`);
}

const SECRET_SHAPED = /secret|hash|key$/i;

describe("api.key.list capability", () => {
  it("is registered under its verb-first name", () => {
    expect(getCapability("list_api_keys")).toBe(apiKeyList);
  });

  it("is a read: mutates false, noBillingGate, org Owner and Admin only", () => {
    expect(apiKeyList.mutates).toBe(false);
    expect(apiKeyList.noBillingGate).toBe(true);
    expect(apiKeyList.scoped).toBe(true);
    expect(apiKeyList.defaultEffect).toBe("deny");
    expect(apiKeyList.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
  });

  it("carries no output field named like a secret, a hash or a key", () => {
    const names = fieldNames(apiKeyList.output);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => SECRET_SHAPED.test(n))).toEqual([]);
  });

  it("the guard itself catches the create contract's rawKey", () => {
    // The regex is only worth trusting if it fires on the one contract that
    // legitimately returns key material.
    expect(
      fieldNames(apiKeyCreate.output).some((n) => SECRET_SHAPED.test(n)),
    ).toBe(true);
  });

  it("accepts an empty input and rejects nothing else", () => {
    expect(apiKeyList.input.parse({})).toEqual({});
  });

  it("parses an item with every nullable field null and one with them set", () => {
    const live = {
      publicId: "aky_live",
      name: "ci",
      prefix: "ox_abcdefghi",
      createdAt: "2026-09-13T10:00:00.000Z",
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    };
    const revoked = {
      ...live,
      publicId: "aky_old",
      lastUsedAt: "2026-09-13T11:00:00.000Z",
      expiresAt: "2027-01-01T00:00:00.000Z",
      revokedAt: "2026-09-13T12:00:00.000Z",
    };
    expect(apiKeyList.output.parse({ items: [live, revoked] })).toEqual({
      items: [live, revoked],
    });
  });

  it("rejects an item that omits revokedAt", () => {
    const { revokedAt: _omitted, ...missing } = {
      publicId: "aky_live",
      name: "ci",
      prefix: "ox_abcdefghi",
      createdAt: "2026-09-13T10:00:00.000Z",
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    };
    expect(() => apiKeyList.output.parse({ items: [missing] })).toThrow();
  });
});
