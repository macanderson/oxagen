// env.test.ts — unit tests for normalizeEnv / loadEnv / requireEnv.
//
// Tests cover quote-stripping, cache behaviour, sub-schema selection,
// and failure modes. No network or file-system access required.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  normalizeEnv,
  loadEnv,
  requireEnv,
  isProductionRuntime,
  __resetEnvCacheForTests,
} from "./env";

// ── Shared minimal env that satisfies baseEnvSchema ───────────────────────────

const VALID_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  CLICKHOUSE_URL: "http://localhost:8123",
  CLICKHOUSE_USERNAME: "default",
  NEO4J_URI: "bolt://localhost:7687",
  NEO4J_USERNAME: "neo4j",
  NEO4J_PASSWORD: "password",
  BETTER_AUTH_SECRET: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  BETTER_AUTH_URL: "http://localhost:3000",
  STRIPE_SECRET_KEY: "sk_test_abc123",
  STRIPE_PUBLISHABLE_KEY: "pk_test_abc123",
  STRIPE_WEBHOOK_SECRET: "whsec_abc123",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  NEXT_PUBLIC_API_URL: "http://localhost:4000",
};

// ── normalizeEnv ──────────────────────────────────────────────────────────────

describe("normalizeEnv", () => {
  it("strips exactly one surrounding double-quote pair from known keys", () => {
    const result = normalizeEnv({
      DATABASE_URL: '"postgresql://user:pass@localhost:5432/db"',
    });
    expect(result["DATABASE_URL"]).toBe(
      "postgresql://user:pass@localhost:5432/db",
    );
  });

  it("leaves unknown keys untouched even when double-quoted", () => {
    const result = normalizeEnv({ UNKNOWN_KEY: '"some_value"' });
    expect(result["UNKNOWN_KEY"]).toBe('"some_value"');
  });

  it("does not mutate values that are not double-wrapped", () => {
    const result = normalizeEnv({
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
    });
    expect(result["DATABASE_URL"]).toBe(
      "postgresql://user:pass@localhost:5432/db",
    );
  });

  it("does not strip a single leading or trailing quote without a match", () => {
    const result = normalizeEnv({ DATABASE_URL: '"postgresql://no-closing' });
    expect(result["DATABASE_URL"]).toBe('"postgresql://no-closing');
  });

  it("does not double-strip triply-quoted values (only one pair removed)", () => {
    const result = normalizeEnv({ DATABASE_URL: '""postgresql://inner""' });
    expect(result["DATABASE_URL"]).toBe('"postgresql://inner"');
  });
});

// ── loadEnv ───────────────────────────────────────────────────────────────────

describe("loadEnv", () => {
  beforeEach(() => {
    __resetEnvCacheForTests();
  });

  it("returns a parsed env for a valid source", () => {
    const env = loadEnv(VALID_ENV);
    expect(env.NODE_ENV).toBe("test");
    expect(env.DATABASE_URL).toBe("postgresql://user:pass@localhost:5432/db");
  });

  it("throws a descriptive error when required vars are missing", () => {
    const incomplete = { ...VALID_ENV };
    delete incomplete.DATABASE_URL;
    expect(() => loadEnv(incomplete)).toThrow(/Invalid environment/);
    expect(() => {
      __resetEnvCacheForTests();
      loadEnv(incomplete);
    }).toThrow(/DATABASE_URL/);
  });

  it("cache reset allows successive loadEnv calls to re-parse", () => {
    const env1 = loadEnv(VALID_ENV);
    __resetEnvCacheForTests();
    // Providing a different source after reset should be re-parsed.
    const env2 = loadEnv({ ...VALID_ENV, NODE_ENV: "production" });
    expect(env1.NODE_ENV).toBe("test");
    expect(env2.NODE_ENV).toBe("production");
  });

  it("returns the cached result without re-parsing on a second call", () => {
    const env1 = loadEnv(VALID_ENV);
    // Pass a different source — without cache reset it should be ignored.
    const env2 = loadEnv({ ...VALID_ENV, NODE_ENV: "production" });
    expect(env1).toBe(env2);
    expect(env2.NODE_ENV).toBe("test");
  });
});

// ── TENANT_RLS_ENFORCEMENT_ENABLED ───────────────────────────────────────────

describe("TENANT_RLS_ENFORCEMENT_ENABLED", () => {
  // The field transform reads the AMBIENT process.env (NODE_ENV/VERCEL_ENV) to
  // decide the unset default, so production-default cases mutate and restore it.
  const savedNodeEnv = process.env.NODE_ENV;
  const savedVercelEnv = process.env.VERCEL_ENV;

  beforeEach(() => {
    __resetEnvCacheForTests();
  });

  afterEach(() => {
    process.env.NODE_ENV = savedNodeEnv;
    if (savedVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = savedVercelEnv;
    __resetEnvCacheForTests();
  });

  it("defaults to false in non-production (dev/test seeding window)", () => {
    // Vitest runs with NODE_ENV=test and no VERCEL_ENV → not production.
    __resetEnvCacheForTests();
    const env = requireEnv(["TENANT_RLS_ENFORCEMENT_ENABLED"], {
      ...process.env,
      TENANT_RLS_ENFORCEMENT_ENABLED: undefined,
    });
    expect(env.TENANT_RLS_ENFORCEMENT_ENABLED).toBe(false);
  });

  it("defaults to TRUE (fail-closed) when unset in a NODE_ENV=production runtime", () => {
    delete process.env.VERCEL_ENV;
    process.env.NODE_ENV = "production";
    __resetEnvCacheForTests();
    const env = requireEnv(["TENANT_RLS_ENFORCEMENT_ENABLED"], {
      ...process.env,
      TENANT_RLS_ENFORCEMENT_ENABLED: undefined,
    });
    expect(env.TENANT_RLS_ENFORCEMENT_ENABLED).toBe(true);
  });

  it("defaults to TRUE (fail-closed) when unset in a VERCEL_ENV=production runtime", () => {
    process.env.VERCEL_ENV = "production";
    __resetEnvCacheForTests();
    const env = requireEnv(["TENANT_RLS_ENFORCEMENT_ENABLED"], {
      ...process.env,
      TENANT_RLS_ENFORCEMENT_ENABLED: undefined,
    });
    expect(env.TENANT_RLS_ENFORCEMENT_ENABLED).toBe(true);
  });

  it("defaults to false on a Vercel PREVIEW deploy (VERCEL_ENV=preview wins over NODE_ENV)", () => {
    // Preview deploys keep NODE_ENV=production but must stay in the seeding window.
    process.env.NODE_ENV = "production";
    process.env.VERCEL_ENV = "preview";
    __resetEnvCacheForTests();
    const env = requireEnv(["TENANT_RLS_ENFORCEMENT_ENABLED"], {
      ...process.env,
      TENANT_RLS_ENFORCEMENT_ENABLED: undefined,
    });
    expect(env.TENANT_RLS_ENFORCEMENT_ENABLED).toBe(false);
  });

  it("honors an explicit 'false' override even in production", () => {
    process.env.VERCEL_ENV = "production";
    __resetEnvCacheForTests();
    const env = requireEnv(["TENANT_RLS_ENFORCEMENT_ENABLED"], {
      ...process.env,
      TENANT_RLS_ENFORCEMENT_ENABLED: "false",
    });
    // The value resolves to false — the startup guard (not the schema) is what
    // refuses to boot in this state; the env itself stays a truthful reflection.
    expect(env.TENANT_RLS_ENFORCEMENT_ENABLED).toBe(false);
  });

  it("coerces TENANT_RLS_ENFORCEMENT_ENABLED='true' to true", () => {
    __resetEnvCacheForTests();
    const env = requireEnv(["TENANT_RLS_ENFORCEMENT_ENABLED"], {
      ...process.env,
      TENANT_RLS_ENFORCEMENT_ENABLED: "true",
    });
    expect(env.TENANT_RLS_ENFORCEMENT_ENABLED).toBe(true);
  });
});

describe("isProductionRuntime", () => {
  it("is true when VERCEL_ENV=production", () => {
    expect(isProductionRuntime({ VERCEL_ENV: "production" })).toBe(true);
  });

  it("is false when VERCEL_ENV=preview even if NODE_ENV=production", () => {
    expect(
      isProductionRuntime({ VERCEL_ENV: "preview", NODE_ENV: "production" }),
    ).toBe(false);
  });

  it("falls back to NODE_ENV=production when VERCEL_ENV is unset", () => {
    expect(isProductionRuntime({ NODE_ENV: "production" })).toBe(true);
  });

  it("is false for a bare development runtime", () => {
    expect(isProductionRuntime({ NODE_ENV: "development" })).toBe(false);
  });
});

// ── Promoted-to-schema vars (registry → baseEnvSchema) ────────────────────────
// Each of these is optional (its consuming surface enforces presence or falls
// back), so an absent value never fails a service that does not use it.

describe("promoted env vars", () => {
  beforeEach(() => {
    __resetEnvCacheForTests();
  });

  it("treats every promoted var as optional when absent", () => {
    const env = requireEnv(
      [
        "NEXT_PUBLIC_DOCS_URL",
        "MCP_URL",
        "INGESTION_CRYPTO_PROVIDER",
        "AWS_KMS_INGESTION_KEY_ARN",
        "INGESTION_ENCRYPTION_KEY",
        "AUDIT_EXPORT_SIGNING_SECRET",
        "PRIVACY_ERASURE_GRACE_DAYS",
        "TAVILY_API_KEY",
      ] as const,
      {},
    );
    expect(env.NEXT_PUBLIC_DOCS_URL).toBeUndefined();
    expect(env.MCP_URL).toBeUndefined();
    expect(env.INGESTION_CRYPTO_PROVIDER).toBeUndefined();
    expect(env.AWS_KMS_INGESTION_KEY_ARN).toBeUndefined();
    expect(env.INGESTION_ENCRYPTION_KEY).toBeUndefined();
    expect(env.AUDIT_EXPORT_SIGNING_SECRET).toBeUndefined();
    expect(env.PRIVACY_ERASURE_GRACE_DAYS).toBeUndefined();
    expect(env.TAVILY_API_KEY).toBeUndefined();
  });

  it("validates NEXT_PUBLIC_DOCS_URL and MCP_URL as URLs", () => {
    const ok = requireEnv(["NEXT_PUBLIC_DOCS_URL", "MCP_URL"] as const, {
      NEXT_PUBLIC_DOCS_URL: "https://docs.example.com",
      MCP_URL: "https://mcp.example.com",
    });
    expect(ok.NEXT_PUBLIC_DOCS_URL).toBe("https://docs.example.com");
    expect(ok.MCP_URL).toBe("https://mcp.example.com");
    expect(() =>
      requireEnv(["MCP_URL"] as const, { MCP_URL: "not-a-url" }),
    ).toThrow(/Invalid environment/);
  });

  it("restricts INGESTION_CRYPTO_PROVIDER to env|kms", () => {
    const env = requireEnv(["INGESTION_CRYPTO_PROVIDER"] as const, {
      INGESTION_CRYPTO_PROVIDER: "kms",
    });
    expect(env.INGESTION_CRYPTO_PROVIDER).toBe("kms");
    expect(() =>
      requireEnv(["INGESTION_CRYPTO_PROVIDER"] as const, {
        INGESTION_CRYPTO_PROVIDER: "vault",
      }),
    ).toThrow(/Invalid environment/);
  });

  it("requires AUDIT_EXPORT_SIGNING_SECRET to be >= 16 chars when set", () => {
    expect(() =>
      requireEnv(["AUDIT_EXPORT_SIGNING_SECRET"] as const, {
        AUDIT_EXPORT_SIGNING_SECRET: "tooshort",
      }),
    ).toThrow(/Invalid environment/);
    const env = requireEnv(["AUDIT_EXPORT_SIGNING_SECRET"] as const, {
      AUDIT_EXPORT_SIGNING_SECRET: "0123456789abcdef0123",
    });
    expect(env.AUDIT_EXPORT_SIGNING_SECRET).toBe("0123456789abcdef0123");
  });

  it("coerces PRIVACY_ERASURE_GRACE_DAYS to a non-negative integer", () => {
    const env = requireEnv(["PRIVACY_ERASURE_GRACE_DAYS"] as const, {
      PRIVACY_ERASURE_GRACE_DAYS: "30",
    });
    expect(env.PRIVACY_ERASURE_GRACE_DAYS).toBe(30);
    const zero = requireEnv(["PRIVACY_ERASURE_GRACE_DAYS"] as const, {
      PRIVACY_ERASURE_GRACE_DAYS: "0",
    });
    expect(zero.PRIVACY_ERASURE_GRACE_DAYS).toBe(0);
    expect(() =>
      requireEnv(["PRIVACY_ERASURE_GRACE_DAYS"] as const, {
        PRIVACY_ERASURE_GRACE_DAYS: "-1",
      }),
    ).toThrow(/Invalid environment/);
  });
});

// ── requireEnv ────────────────────────────────────────────────────────────────

describe("requireEnv", () => {
  it("returns only the requested subset typed correctly", () => {
    const env = requireEnv(["DATABASE_URL", "NODE_ENV"] as const, VALID_ENV);
    expect(env.DATABASE_URL).toBe("postgresql://user:pass@localhost:5432/db");
    expect(env.NODE_ENV).toBe("test");
    // TypeScript ensures other keys are not present on the type.
  });

  it("throws when a required key is absent from the source", () => {
    const incomplete = { ...VALID_ENV };
    delete incomplete.DATABASE_URL;
    expect(() => requireEnv(["DATABASE_URL"] as const, incomplete)).toThrow(
      /Invalid environment/,
    );
  });

  it("does not require keys outside the requested subset", () => {
    // Strip everything except the one key we need.
    const sparse: NodeJS.ProcessEnv = { DATABASE_URL: VALID_ENV.DATABASE_URL };
    const env = requireEnv(["DATABASE_URL"] as const, sparse);
    expect(env.DATABASE_URL).toBe(VALID_ENV.DATABASE_URL);
  });
});
