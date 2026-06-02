import { describe, expect, it } from "vitest";
import { baseEnvSchema } from "./env";
import {
  ENV_REGISTRY,
  ENV_NAMES,
  SERVICE_NAMES,
  clientKeys,
  isValidated,
  registryKeys,
  renderEnvExample,
  requiredKeysFor,
  secretKeys,
  staticValueFor,
} from "./registry";

const SCHEMA_KEYS = Object.keys(baseEnvSchema.shape);

describe("ENV_REGISTRY ↔ baseEnvSchema coverage", () => {
  it("every schema key has a registry entry (schema ⊆ registry)", () => {
    const missing = SCHEMA_KEYS.filter((k) => !(k in ENV_REGISTRY));
    expect(missing, `schema keys absent from ENV_REGISTRY: ${missing.join(", ")}`).toEqual([]);
  });

  it("isValidated() is true for exactly the schema keys", () => {
    for (const k of SCHEMA_KEYS) expect(isValidated(k), `${k} should be validated`).toBe(true);
    const extra = registryKeys().filter((k) => !SCHEMA_KEYS.includes(k));
    for (const k of extra) expect(isValidated(k), `${k} should NOT be validated`).toBe(false);
  });

  it("the registry is a superset (it documents schema keys plus tooling/unvalidated vars)", () => {
    expect(registryKeys().length).toBeGreaterThan(SCHEMA_KEYS.length);
    expect(SCHEMA_KEYS.every((k) => registryKeys().includes(k))).toBe(true);
  });
});

describe("registry entry shape", () => {
  it("every entry has a known group, valid services, and valid requiredIn envs", () => {
    for (const [key, meta] of Object.entries(ENV_REGISTRY)) {
      expect(meta.group.length, `${key}.group`).toBeGreaterThan(0);
      expect(meta.description.length, `${key}.description`).toBeGreaterThan(0);
      for (const s of meta.services) expect(SERVICE_NAMES, `${key}.services`).toContain(s);
      for (const e of meta.requiredIn) expect(ENV_NAMES, `${key}.requiredIn`).toContain(e);
    }
  });

  it("client-exposed vars use the NEXT_PUBLIC_ prefix and vice versa", () => {
    for (const [key, meta] of Object.entries(ENV_REGISTRY)) {
      if (meta.clientExposed) expect(key.startsWith("NEXT_PUBLIC_"), `${key} clientExposed`).toBe(true);
      if (key.startsWith("NEXT_PUBLIC_")) expect(meta.clientExposed, `${key} prefix`).toBe(true);
    }
  });

  it("static vars define a value (per-env or shared); non-static do not", () => {
    for (const [key, meta] of Object.entries(ENV_REGISTRY)) {
      if (meta.valueOrigin === "static") {
        expect(meta.staticValue, `${key} static needs staticValue`).toBeDefined();
        const someEnv = ENV_NAMES.some((e) => staticValueFor(key, e) !== undefined);
        expect(someEnv, `${key} resolves a static value`).toBe(true);
      } else {
        expect(meta.staticValue, `${key} non-static must not bake a value`).toBeUndefined();
      }
    }
  });

  it("a required var is required only on surfaces that actually consume it", () => {
    for (const [key, meta] of Object.entries(ENV_REGISTRY)) {
      if (meta.requiredIn.length > 0) {
        expect(meta.services.length, `${key} is required but no service consumes it`).toBeGreaterThan(0);
      }
    }
  });
});

describe("derivation helpers", () => {
  it("requiredKeysFor only returns keys that consume the service in that env", () => {
    const apiProd = requiredKeysFor("api", "production");
    expect(apiProd).toContain("DATABASE_URL");
    expect(apiProd).toContain("BETTER_AUTH_SECRET");
    // INNGEST is required in preview/production but not development.
    expect(apiProd).toContain("INNGEST_SIGNING_KEY");
    expect(requiredKeysFor("api", "development")).not.toContain("INNGEST_SIGNING_KEY");
    // website has no required runtime secrets.
    expect(requiredKeysFor("website", "production")).not.toContain("DATABASE_URL");
  });

  it("clientKeys are exactly the NEXT_PUBLIC_ vars", () => {
    expect(clientKeys().sort()).toEqual(registryKeys().filter((k) => k.startsWith("NEXT_PUBLIC_")).sort());
  });

  it("secretKeys includes credentials and excludes plain config", () => {
    expect(secretKeys()).toContain("DATABASE_URL");
    expect(secretKeys()).toContain("STRIPE_SECRET_KEY");
    expect(secretKeys()).not.toContain("NEXT_PUBLIC_APP_URL");
    expect(secretKeys()).not.toContain("CLICKHOUSE_DATABASE");
  });
});

describe("renderEnvExample", () => {
  const example = renderEnvExample();

  it("emits a KEY= line for every registry var", () => {
    for (const key of registryKeys()) {
      expect(example, `${key} missing from generated .env.example`).toContain(`\n${key}=`);
    }
  });

  it("is deterministic (stable across calls)", () => {
    expect(renderEnvExample()).toBe(example);
  });

  it("bakes development static values and flags unvalidated vars", () => {
    expect(example).toContain("NEO4J_DATABASE=neo4j");
    expect(example).toContain("OXAGEN_TARGET_MARGIN=0.65");
    expect(example).toMatch(/LOG_LEVEL=.*\n?/);
    expect(example).toContain("not-in-schema");
  });
});
