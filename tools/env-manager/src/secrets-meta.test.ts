import { describe, expect, it } from "vitest";
import {
  canonicalize,
  cliGenCommand,
  docFor,
  resolveEnvKey,
} from "./secrets-meta";

describe("canonicalize", () => {
  it("strips the oxagen- prefix and env suffixes, upper-snake-casing the rest", () => {
    expect(canonicalize("oxagen-stripe-secret")).toBe("STRIPE_SECRET");
    expect(canonicalize("oxagen-database-url-production")).toBe("DATABASE_URL");
    expect(canonicalize("oxagen-plaid-secret-sandbox")).toBe("PLAID_SECRET");
  });
  it("leaves already-canonical names intact", () => {
    expect(canonicalize("DATABASE_URL")).toBe("DATABASE_URL");
  });
});

describe("resolveEnvKey", () => {
  it("resolves explicit aliases (renamed / AI-gateway-routed providers)", () => {
    expect(resolveEnvKey("oxagen-stripe-secret")).toBe("STRIPE_SECRET_KEY");
    expect(resolveEnvKey("oxagen-anthropic-key")).toBe("AI_GATEWAY_API_KEY");
    expect(resolveEnvKey("oxagen-resend-api-key")).toBe("SMTP_PASSWORD");
  });
  it("resolves an exact registry key", () => {
    expect(resolveEnvKey("DATABASE_URL")).toBe("DATABASE_URL");
  });
  it("resolves via canonical-name equality against the registry", () => {
    expect(resolveEnvKey("oxagen-linear-api-key")).toBe("LINEAR_API_KEY");
  });
  it("returns null when nothing matches", () => {
    expect(resolveEnvKey("oxagen-stripe-price-credit-500")).toBeNull();
  });
});

describe("cliGenCommand", () => {
  it("returns an openssl genpkey command for a JWT private key", () => {
    expect(cliGenCommand("oxagen-jwt-private-key")).toContain(
      "openssl genpkey",
    );
  });
  it("derives the public key from the private one", () => {
    expect(cliGenCommand("oxagen-jwt-public-key")).toContain("pkey");
    expect(cliGenCommand("oxagen-jwt-public-key")).toContain("-pubout");
  });
  it("returns a base64 mint for encryption keys and signing secrets", () => {
    expect(cliGenCommand("oxagen-encryption-key")).toContain(
      "openssl rand -base64 32",
    );
    expect(cliGenCommand("oxagen-admin-auth-secret")).toContain(
      "openssl rand -base64 32",
    );
  });
  it("returns a shorter base64 mint for passwords", () => {
    expect(cliGenCommand("oxagen-pgadmin-password")).toContain(
      "openssl rand -base64 24",
    );
  });
  it("returns null for credentials that must come from a vendor", () => {
    expect(cliGenCommand("oxagen-stripe-secret")).toBeNull();
  });
});

describe("docFor", () => {
  it("reuses the rich registry description and pairs it with the provider URL", () => {
    const d = docFor("oxagen-stripe-secret", "STRIPE_SECRET_KEY");
    expect(d.description.toLowerCase()).toContain("stripe");
    expect(d.vendor_url).toBe("https://dashboard.stripe.com/apikeys");
  });

  it("falls back to the provider table when no registry key maps", () => {
    const d = docFor("oxagen-stripe-price-credit-500", null);
    expect(d.description).toContain("Stripe price id");
    expect(d.vendor_url).toBe("https://dashboard.stripe.com/products");
  });

  it("appends a CLI mint clause for random-material secrets and points at GCP", () => {
    const d = docFor("oxagen-jwt-private-key", null);
    expect(d.description).toContain("openssl");
    expect(d.vendor_url).toContain("secret-manager");
  });

  it("produces a generic description for unknown secrets", () => {
    const d = docFor("totally-unknown-thing", null);
    expect(d.description).toContain("totally unknown thing");
  });

  // One representative name per provider — exercises every provider's test()
  // and describe(), and asserts each yields a usable vendor URL + description.
  const PROVIDER_SAMPLES = [
    "oxagen-anthropic-key",
    "oxagen-openai-api-key",
    "mistral-api-key",
    "oxagen-elevenlabs-api-key",
    "oxagen-ideogram-api-key",
    "oxagen-runway-api-secret",
    "oxagen-tavily-api-key",
    "e2b-api-key",
    "oxagen-embedding-api-key",
    "oxagen-stripe-price-credit-500",
    "oxagen-stripe-webhook-secret",
    "oxagen-stripe-secret",
    "oxagen-stripe-publishable-key",
    "oxagen-linear-api-key",
    "oxagen-linear-webhook-secret",
    "oxagen-linear-client-id",
    "oxagen-github-app-private-key",
    "oxagen-github-app-webhook-secret",
    "oxagen-github-app-client-id",
    "oxagen-google-gmail-client-secret",
    "oxagen-google-client-id",
    "oxagen-neo4j-aura-client-id",
    "oxagen-neo4j-shared-uswest1-uri",
    "oxagen-clickhouse-url",
    "clickpipes-password",
    "oxagen-plaid-client-id",
    "oxagen-plaid-secret",
    "oxagen-twilio-auth-staging",
    "oxagen-zoom-webhook-secret",
    "oxagen-zoom-client-id",
    "oxagen-resend-api-key",
    "oxagen-smtp-password",
    "oxagen-resend-webhook-secret",
    "oxagen-posthog-host",
    "oxagen-posthog-key",
    "oxagen-vercel-token",
    "oxagen-redis-url",
    "oxagen-valkey-auth",
    "oxagen-celery-broker-url",
    "oxagen-alloydb-server-ca",
    "oxagen-gotenberg-url",
    "postgres_password",
    "oxagen-pgadmin-password",
  ];

  it.each(PROVIDER_SAMPLES)(
    "gives %s a non-empty description and https vendor_url",
    (name) => {
      const d = docFor(name, null);
      expect(d.description.length).toBeGreaterThan(5);
      expect(d.vendor_url).toMatch(/^https:\/\//);
    },
  );
});
