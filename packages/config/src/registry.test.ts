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
    expect(
      missing,
      `schema keys absent from ENV_REGISTRY: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("isValidated() is true for exactly the schema keys", () => {
    for (const k of SCHEMA_KEYS)
      expect(isValidated(k), `${k} should be validated`).toBe(true);
    const extra = registryKeys().filter((k) => !SCHEMA_KEYS.includes(k));
    for (const k of extra)
      expect(isValidated(k), `${k} should NOT be validated`).toBe(false);
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
      for (const s of meta.services)
        expect(SERVICE_NAMES, `${key}.services`).toContain(s);
      for (const e of meta.requiredIn)
        expect(ENV_NAMES, `${key}.requiredIn`).toContain(e);
    }
  });

  it("client-exposed vars use the NEXT_PUBLIC_ prefix and vice versa", () => {
    for (const [key, meta] of Object.entries(ENV_REGISTRY)) {
      if (meta.clientExposed)
        expect(key.startsWith("NEXT_PUBLIC_"), `${key} clientExposed`).toBe(
          true,
        );
      if (key.startsWith("NEXT_PUBLIC_"))
        expect(meta.clientExposed, `${key} prefix`).toBe(true);
    }
  });

  it("static vars define a value (per-env or shared); non-static do not", () => {
    for (const [key, meta] of Object.entries(ENV_REGISTRY)) {
      if (meta.valueOrigin === "static") {
        expect(
          meta.staticValue,
          `${key} static needs staticValue`,
        ).toBeDefined();
        const someEnv = ENV_NAMES.some(
          (e) => staticValueFor(key, e) !== undefined,
        );
        expect(someEnv, `${key} resolves a static value`).toBe(true);
      } else {
        expect(
          meta.staticValue,
          `${key} non-static must not bake a value`,
        ).toBeUndefined();
      }
    }
  });

  it("a required var is required only on surfaces that actually consume it", () => {
    for (const [key, meta] of Object.entries(ENV_REGISTRY)) {
      if (meta.requiredIn.length > 0) {
        expect(
          meta.services.length,
          `${key} is required but no service consumes it`,
        ).toBeGreaterThan(0);
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
    expect(requiredKeysFor("api", "development")).not.toContain(
      "INNGEST_SIGNING_KEY",
    );
    // website has no required runtime secrets.
    expect(requiredKeysFor("website", "production")).not.toContain(
      "DATABASE_URL",
    );
  });

  it("clientKeys are exactly the NEXT_PUBLIC_ vars", () => {
    expect(clientKeys().sort()).toEqual(
      registryKeys()
        .filter((k) => k.startsWith("NEXT_PUBLIC_"))
        .sort(),
    );
  });

  it("secretKeys includes credentials and excludes plain config", () => {
    expect(secretKeys()).toContain("DATABASE_URL");
    expect(secretKeys()).toContain("STRIPE_SECRET_KEY");
    expect(secretKeys()).not.toContain("NEXT_PUBLIC_APP_URL");
    expect(secretKeys()).not.toContain("CLICKHOUSE_DATABASE");
  });
});

describe("staticValueFor — extended cases", () => {
  it("wildcard '*' key returns its value for every env", () => {
    // CLICKHOUSE_DATABASE has staticValue: { "*": "oxagen" }
    expect(staticValueFor("CLICKHOUSE_DATABASE", "development")).toBe("oxagen");
    expect(staticValueFor("CLICKHOUSE_DATABASE", "preview")).toBe("oxagen");
    expect(staticValueFor("CLICKHOUSE_DATABASE", "production")).toBe("oxagen");
  });

  it("env-specific override: NODE_ENV → 'development' in development, 'production' in production", () => {
    expect(staticValueFor("NODE_ENV", "development")).toBe("development");
    expect(staticValueFor("NODE_ENV", "production")).toBe("production");
  });

  it("env-specific override: NODE_ENV preview → 'production' (preview bakes production value)", () => {
    expect(staticValueFor("NODE_ENV", "preview")).toBe("production");
  });

  it("non-static key (valueOrigin='manual') → returns undefined", () => {
    // DATABASE_URL is manual — no staticValue
    expect(staticValueFor("DATABASE_URL", "development")).toBeUndefined();
    expect(staticValueFor("DATABASE_URL", "production")).toBeUndefined();
  });

  it("unknown key → returns undefined", () => {
    expect(
      staticValueFor("__TOTALLY_UNKNOWN_KEY__", "development"),
    ).toBeUndefined();
  });
});

// The DEFAULT is the whole point of these three flags, so it is asserted
// rather than left to a reviewer's memory: shipping the wrong one either
// strands the durable-run queue or mints finalization obligations no deployed
// worker can satisfy (docs/specs/run-evidence-ingress/
// 02-run-attempt-foundation-plan.md, PR 1A/1B split).
describe("durable-run gate defaults", () => {
  it("OXAGEN_DURABLE_RUNS defaults OFF — the router stays unmounted", () => {
    for (const env of ["development", "preview", "production"] as const) {
      expect(staticValueFor("OXAGEN_DURABLE_RUNS", env)).toBe("false");
    }
  });

  it("OXAGEN_V1_RUN_ADMISSION_ENABLED defaults ON — PR 1A must not close the v1 queue", () => {
    // Closing legacy admission is PR 1B's cutover, and it may only happen
    // after already-enqueued v1 work has drained.
    for (const env of ["development", "preview", "production"] as const) {
      expect(staticValueFor("OXAGEN_V1_RUN_ADMISSION_ENABLED", env)).toBe(
        "true",
      );
    }
  });

  it("OXAGEN_RUN_V2_CLAIMS_ENABLED defaults OFF — v2 execution waits for PR 2B", () => {
    // Every v2 seal mints a one-shot finalization grant and a durable
    // obligation. Until PR 2B deploys the consumer, each one would be an
    // obligation nothing can discharge.
    for (const env of ["development", "preview", "production"] as const) {
      expect(staticValueFor("OXAGEN_RUN_V2_CLAIMS_ENABLED", env)).toBe("false");
    }
  });
});

describe("requiredKeysFor — boundary cases", () => {
  it("a key scoped services:['api'] must NOT appear for service 'website'", () => {
    // DATABASE_URL services: ["api", "app", "mcp", "admin"] — not website
    const websiteProd = requiredKeysFor("website", "production");
    expect(websiteProd).not.toContain("DATABASE_URL");
  });

  it("a key scoped services:['api'] must NOT appear for service 'docs'", () => {
    const docsProd = requiredKeysFor("docs", "production");
    expect(docsProd).not.toContain("DATABASE_URL");
  });

  it("BETTER_AUTH_SECRET appears for api+production but not website+production", () => {
    // Derives from the actual registry — not hardcoded booleans.
    const apiProd = requiredKeysFor("api", "production");
    const websiteProd = requiredKeysFor("website", "production");
    expect(apiProd).toContain("BETTER_AUTH_SECRET");
    expect(websiteProd).not.toContain("BETTER_AUTH_SECRET");
  });

  it("result contains only keys whose services include the requested service", () => {
    for (const svc of SERVICE_NAMES) {
      const keys = requiredKeysFor(svc, "production");
      for (const k of keys) {
        expect(
          ENV_REGISTRY[k]?.services,
          `${k} returned for ${svc} but its services array doesn't include it`,
        ).toContain(svc);
      }
    }
  });

  it("result contains only keys whose requiredIn includes the requested env", () => {
    for (const svc of SERVICE_NAMES) {
      const keys = requiredKeysFor(svc, "production");
      for (const k of keys) {
        expect(
          ENV_REGISTRY[k]?.requiredIn,
          `${k} returned for production but its requiredIn doesn't include production`,
        ).toContain("production");
      }
    }
  });
});

describe("renderEnvExample", () => {
  const example = renderEnvExample();

  it("emits a KEY= line for every registry var", () => {
    for (const key of registryKeys()) {
      expect(example, `${key} missing from generated .env.example`).toContain(
        `\n${key}=`,
      );
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
