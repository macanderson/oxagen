// env.test.ts — unit tests for normalizeEnv / loadEnv / requireEnv.
//
// Tests cover quote-stripping, cache behaviour, sub-schema selection,
// and failure modes. No network or file-system access required.

import { describe, expect, it, beforeEach } from "vitest";
import {
  normalizeEnv,
  loadEnv,
  requireEnv,
  __resetEnvCacheForTests,
} from "./env.js";

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
    const result = normalizeEnv({ DATABASE_URL: '"postgresql://user:pass@localhost:5432/db"' });
    expect(result["DATABASE_URL"]).toBe("postgresql://user:pass@localhost:5432/db");
  });

  it("leaves unknown keys untouched even when double-quoted", () => {
    const result = normalizeEnv({ UNKNOWN_KEY: '"some_value"' });
    expect(result["UNKNOWN_KEY"]).toBe('"some_value"');
  });

  it("does not mutate values that are not double-wrapped", () => {
    const result = normalizeEnv({ DATABASE_URL: "postgresql://user:pass@localhost:5432/db" });
    expect(result["DATABASE_URL"]).toBe("postgresql://user:pass@localhost:5432/db");
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
    expect(() => requireEnv(["DATABASE_URL"] as const, incomplete)).toThrow(/Invalid environment/);
  });

  it("does not require keys outside the requested subset", () => {
    // Strip everything except the one key we need.
    const sparse: NodeJS.ProcessEnv = { DATABASE_URL: VALID_ENV.DATABASE_URL };
    const env = requireEnv(["DATABASE_URL"] as const, sparse);
    expect(env.DATABASE_URL).toBe(VALID_ENV.DATABASE_URL);
  });
});
