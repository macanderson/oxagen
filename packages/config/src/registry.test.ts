import { describe, expect, it } from "vitest";
import { baseEnvSchema } from "./env";
import { CI_REGISTRY, ciSaveCommand } from "./ci-registry";
import {
  ENV_REGISTRY,
  ENV_NAMES,
  OPERATOR_PARAMETER_PREFIX,
  PARAMETER_PREFIXES,
  SERVICE_NAMES,
  clientKeys,
  isValidated,
  keysInStore,
  parameterName,
  registryKeys,
  renderEnvExample,
  requiredKeysFor,
  secretKeys,
  staticValueFor,
  storeOf,
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
  it("routes the optional public OpenAI Apps verification challenge only to MCP", () => {
    expect(ENV_REGISTRY.OPENAI_APPS_VERIFICATION_TOKEN).toMatchObject({
      services: ["mcp"],
      requiredIn: [],
      secret: false,
      clientExposed: false,
    });
    expect(baseEnvSchema.shape.OPENAI_APPS_VERIFICATION_TOKEN.parse(undefined)).toBeUndefined();
    expect(baseEnvSchema.shape.OPENAI_APPS_VERIFICATION_TOKEN.parse("challenge")).toBe("challenge");
  });

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

describe("ADR-131 per-organisation key provisioning", () => {
  // `create_organization` declares `surfaces: ["api", "mcp", "agent"]`, and
  // `build-env.ts` omits every variable whose registry entry does not name the
  // target service. A service that can create an organisation without these two
  // takes the provisioner's `disabled` path silently and leaves that
  // organisation on the shared key, which is the outcome ADR-131 exists to end.
  it.each(["OPENROUTER_MANAGEMENT_KEY", "OPENROUTER_ORG_KEY_DAILY_LIMIT_USD"])(
    "%s reaches every service that can create an organisation",
    (key) => {
      const entry = ENV_REGISTRY[key as keyof typeof ENV_REGISTRY];
      expect(entry).toBeDefined();
      expect(entry?.services).toEqual(
        expect.arrayContaining(["api", "app", "mcp"]),
      );
    },
  );

  // `build-env.ts` resolves a static value before it consults Parameter Store
  // (`staticValue ?? fromStore.get(key)`), so a static entry here would read a
  // deployed ceiling and discard it. The code's own fallback in `dailyLimitUsd()`
  // and `env.ts` supplies 25 when the variable is unset.
  it("leaves the daily ceiling operator-settable rather than static", () => {
    expect(ENV_REGISTRY.OPENROUTER_ORG_KEY_DAILY_LIMIT_USD?.valueOrigin).toBe(
      "manual",
    );
  });

  // Unset and empty are different inputs and only one of them is safe.
  // `renderEnvExample` writes `KEY=` for a manual var with no placeholder, and
  // a developer following the documented `cp .env.example .env.local` then
  // hands `loadEnv()` an empty string. `z.coerce.number()` turns "" into 0,
  // `.positive()` rejects it, and `.default(25)` never fires because the value
  // is not undefined — the API refuses to start on a file it was told to copy.
  it("renders a usable daily ceiling in .env.example rather than an empty one", () => {
    expect(renderEnvExample()).toContain(
      "\nOPENROUTER_ORG_KEY_DAILY_LIMIT_USD=25",
    );
  });

  it("rejects the empty string the generator would otherwise emit", () => {
    expect(
      baseEnvSchema.shape.OPENROUTER_ORG_KEY_DAILY_LIMIT_USD.safeParse("")
        .success,
    ).toBe(false);
    expect(
      baseEnvSchema.shape.OPENROUTER_ORG_KEY_DAILY_LIMIT_USD.parse(undefined),
    ).toBe(25);
  });

  // Minting is only half of provisioning. `recordAssistantModelKey` envelopes
  // the key with this KEK and raises AssistantModelKeyKekUnsetError without it,
  // after which the caller deletes the key it just minted and the organisation
  // stays on the shared key. A service that can create an organisation needs
  // both variables or it silently achieves nothing.
  it("routes the envelope KEK to every service that can store a minted key", () => {
    expect(ENV_REGISTRY.AUTH_TOKEN_ENCRYPTION_KEY?.services).toEqual(
      expect.arrayContaining(["api", "app", "mcp"]),
    );
  });
});

// ADR-240: Parameter Store holds every value, and the registry says where each
// one lives and how to mint a new one. The Architecture Atlas renders both.
describe("value stores and refresh steps", () => {
  it("gives every stored variable a refresh step", () => {
    const missing = [
      ...keysInStore("environment"),
      ...keysInStore("operator"),
    ].filter((k) => !ENV_REGISTRY[k]?.refresh?.how.trim());
    expect(
      missing,
      `stored variables with no refresh: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("keeps a static value in the registry and nowhere else", () => {
    for (const [key, meta] of Object.entries(ENV_REGISTRY)) {
      if (meta.valueOrigin === "static")
        expect(storeOf(key), `${key} is static`).toBe("registry");
      else expect(storeOf(key), `${key} is not static`).not.toBe("registry");
    }
  });

  it("lists every CI-held variable in CI_REGISTRY", () => {
    const missing = keysInStore("ci").filter((k) => !(k in CI_REGISTRY));
    expect(
      missing,
      `ci-store keys absent from CI_REGISTRY: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("stores a variable a service reads unless it is declared shell-only", () => {
    for (const [key, meta] of Object.entries(ENV_REGISTRY)) {
      if (meta.services.length === 0 || meta.valueOrigin === "static") continue;
      expect(["environment", "shell"], `${key} store`).toContain(storeOf(key));
    }
  });

  it("names one parameter per environment, and one for an operator value", () => {
    expect(parameterName("STRIPE_SECRET_KEY", "development")).toBe(
      "/oxagen/development/STRIPE_SECRET_KEY",
    );
    expect(parameterName("STRIPE_SECRET_KEY", "preview")).toBe(
      "/oxagen/staging/STRIPE_SECRET_KEY",
    );
    expect(parameterName("STRIPE_SECRET_KEY", "production")).toBe(
      "/oxagen/production/STRIPE_SECRET_KEY",
    );
    expect(parameterName("NPM_TOKEN", "production")).toBe(
      `${OPERATOR_PARAMETER_PREFIX}/NPM_TOKEN`,
    );
    expect(parameterName("CLICKHOUSE_DATABASE", "production")).toBeUndefined();
    expect(parameterName("GITLAB_TOKEN", "development")).toBeUndefined();
  });

  it("maps every environment to a prefix under /oxagen", () => {
    for (const env of ENV_NAMES)
      expect(PARAMETER_PREFIXES[env]).toMatch(/^\/oxagen\/[a-z]+$/);
  });
});

describe("CI_REGISTRY", () => {
  it("describes every entry and says how to refresh it", () => {
    for (const [name, meta] of Object.entries(CI_REGISTRY)) {
      expect(name, `${name} name`).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(
        meta.description.trim().length,
        `${name}.description`,
      ).toBeGreaterThan(0);
      expect(meta.refresh.how.trim().length, `${name}.refresh`).toBeGreaterThan(
        0,
      );
    }
  });

  it("never lists GitHub's own token", () => {
    expect("GITHUB_TOKEN" in CI_REGISTRY).toBe(false);
  });

  it("saves a secret with gh secret set and a variable with gh variable set", () => {
    expect(ciSaveCommand("NPM_TOKEN")).toBe("gh secret set NPM_TOKEN");
    expect(ciSaveCommand("STRIPE_SECRET_KEY")).toBe(
      "gh secret set STRIPE_SECRET_KEY --env production",
    );
    expect(ciSaveCommand("STAGING_ENABLED")).toMatch(
      /^gh variable set STAGING_ENABLED --body /,
    );
    expect(ciSaveCommand("NOT_A_CI_VALUE")).toBeUndefined();
  });
});
