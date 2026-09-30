import { describe, expect, it } from "vitest";
import { ENV_REGISTRY, staticValueFor } from "@oxagen/config";
import {
  renderEnvFile,
  renderRuntimeEnv,
  resolveBuildEnv,
  shellQuote,
  type Parameter,
} from "./build-env";

const PREFIX = "/oxagen/production";

function param(name: string, value: string): Parameter {
  return { Name: `${PREFIX}/${name}`, Value: value };
}

/** Every variable the registry requires of `app` in production. */
function requiredForApp(): string[] {
  return Object.entries(ENV_REGISTRY)
    .filter(
      ([, meta]) =>
        meta.services.includes("app") &&
        meta.requiredIn.includes("production") &&
        meta.valueOrigin !== "static",
    )
    .map(([key]) => key);
}

describe("resolveBuildEnv", () => {
  it("reports what the three hardcoded hostnames leave out", () => {
    // The state of `deploy-node` before #1190: the public URLs are supplied
    // (from the registry's own static values) and nothing else is.
    const { resolved, missingRequired } = resolveBuildEnv({
      service: "app",
      env: "production",
      parameters: [],
      prefix: PREFIX,
    });

    expect(resolved.map((entry) => entry.key)).toContain("NEXT_PUBLIC_APP_URL");
    expect(missingRequired).toContain("BETTER_AUTH_SECRET");
    expect(missingRequired.length).toBeGreaterThan(0);
  });

  it("resolves the public URLs from the registry, without Parameter Store", () => {
    const { resolved } = resolveBuildEnv({
      service: "app",
      env: "production",
      parameters: [],
      prefix: PREFIX,
    });

    const appUrl = resolved.find((e) => e.key === "NEXT_PUBLIC_APP_URL");
    expect(appUrl).toMatchObject({
      value: "https://oxagen.app",
      source: "registry",
    });
  });

  it("carries the Tacho signing material to the api service", () => {
    // A variable no service claims is dropped from the env file, so both
    // secrets sat in Parameter Store while the api process had neither and
    // every enrollment answered 500.
    const pem =
      "-----BEGIN PRIVATE KEY-----\\nMC4CAQAwBQYDK2VwBCIEIA==\\n-----END PRIVATE KEY-----\\n";
    const { resolved } = resolveBuildEnv({
      service: "api",
      env: "production",
      parameters: [
        param("TACHO_ENROLLMENT_SIGNING_SECRET", "hmac-secret"),
        param("TACHO_BUNDLE_SIGNING_PRIVATE_KEY", pem),
      ],
      prefix: PREFIX,
    });

    const keys = resolved.map((entry) => entry.key);
    expect(keys).toContain("TACHO_ENROLLMENT_SIGNING_SECRET");
    expect(keys).toContain("TACHO_BUNDLE_SIGNING_PRIVATE_KEY");
    // The PEM is stored with its newlines escaped and un-escaped at read
    // time, so the backslashes must survive the file verbatim.
    expect(renderEnvFile(resolved)).toContain(
      `TACHO_BUNDLE_SIGNING_PRIVATE_KEY=${shellQuote(pem)}`,
    );
  });

  it("is satisfied once Parameter Store supplies the required set", () => {
    const parameters = requiredForApp().map((key) =>
      param(key, `value-${key}`),
    );

    const { missingRequired, resolved } = resolveBuildEnv({
      service: "app",
      env: "production",
      parameters,
      prefix: PREFIX,
    });

    expect(missingRequired).toEqual([]);
    expect(resolved.find((e) => e.key === "BETTER_AUTH_SECRET")).toMatchObject({
      source: "parameter-store",
    });
  });

  it("keeps a variable belonging to another service out of this build", () => {
    // A registry entry scoped to `api` alone must not reach an `app` build.
    const apiOnly = Object.entries(ENV_REGISTRY).find(
      ([, meta]) =>
        meta.services.includes("api") && !meta.services.includes("app"),
    );
    expect(apiOnly).toBeDefined();
    const [key] = apiOnly as [string, unknown];

    const { resolved } = resolveBuildEnv({
      service: "app",
      env: "production",
      parameters: [param(key, "secret")],
      prefix: PREFIX,
    });

    expect(resolved.map((entry) => entry.key)).not.toContain(key);
  });

  it("separates an optional gap from a required one", () => {
    // NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is `requiredIn: []` — its absence
    // degrades Stripe Elements rather than failing the build (#1182).
    const { missingInlined, missingRequired } = resolveBuildEnv({
      service: "app",
      env: "production",
      parameters: requiredForApp().map((key) => param(key, "v")),
      prefix: PREFIX,
    });

    expect(missingRequired).toEqual([]);
    expect(missingInlined).toContain("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY");
  });

  it("warns about a missing client value, stays quiet about a server-side one", () => {
    // The distinction that makes the warning worth reading: a value compiled
    // into the bundle is absent for the artifact's life, while a server-side
    // one the node can supply at container start is not a build-time defect.
    const { missingInlined, missingOptional } = resolveBuildEnv({
      service: "app",
      env: "production",
      parameters: requiredForApp().map((key) => param(key, "v")),
      prefix: PREFIX,
    });

    for (const key of missingInlined) {
      expect(ENV_REGISTRY[key]?.clientExposed).toBe(true);
    }
    for (const key of missingOptional) {
      expect(ENV_REGISTRY[key]?.clientExposed).toBe(false);
    }
    // STORAGE_DRIVER is server-side: the node reads it at container start.
    expect(missingInlined).not.toContain("STORAGE_DRIVER");
  });

  it("ignores a nested parameter path, which is not a shell variable name", () => {
    const { resolved } = resolveBuildEnv({
      service: "app",
      env: "production",
      parameters: [{ Name: `${PREFIX}/neo4j/password`, Value: "hunter2" }],
      prefix: PREFIX,
    });

    expect(resolved.map((e) => e.value)).not.toContain("hunter2");
  });
});

describe("shellQuote", () => {
  it("survives a value containing a single quote", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("renders a sourceable file", () => {
    const file = renderEnvFile([
      { key: "A", value: "plain", secret: false, source: "registry" },
      {
        key: "B",
        value: "two\nlines",
        secret: true,
        source: "parameter-store",
      },
    ]);

    expect(file).toBe("A='plain'\nB='two\nlines'\n");
  });
});

describe("preview without OAuth", () => {
  it("omits providers explicitly while preserving required database and payment configuration", () => {
    const result = resolveBuildEnv({
      service: "app",
      env: "preview",
      parameters: [],
      prefix: "/oxagen/staging",
      withoutOAuth: true,
    });
    expect(result.missingRequired).not.toContain("GOOGLE_LOGIN_CLIENT_ID");
    expect(result.missingRequired).not.toContain("GITHUB_LOGIN_CLIENT_SECRET");
    expect(result.missingRequired).toContain("DATABASE_URL");
    expect(result.missingRequired).toContain("STRIPE_SECRET_KEY");
    expect(
      result.resolved.some((entry) => entry.key.includes("LOGIN_CLIENT")),
    ).toBe(false);
  });
  it("refuses the omission for production", () => {
    expect(() =>
      resolveBuildEnv({
        service: "app",
        env: "production",
        parameters: [],
        prefix: PREFIX,
        withoutOAuth: true,
      }),
    ).toThrow("only for preview");
  });
});

describe("runtime fill", () => {
  const appUrl = staticValueFor("APP_URL", "production");

  it("carries a static value no parameter holds to the running container", () => {
    // Production's APP_URL: set by the registry, held by no parameter, and
    // read at request time by the Slack and Linear connect flows.
    expect(appUrl).toBeDefined();
    const { runtimeFill } = resolveBuildEnv({
      service: "app",
      env: "production",
      parameters: [],
      prefix: PREFIX,
    });
    expect(runtimeFill.find((entry) => entry.key === "APP_URL")?.value).toBe(
      appUrl,
    );
  });

  it("leaves a value Parameter Store holds to Parameter Store", () => {
    const { runtimeFill, drift } = resolveBuildEnv({
      service: "app",
      env: "production",
      parameters: [param("APP_URL", appUrl ?? "")],
      prefix: PREFIX,
    });
    expect(runtimeFill.map((entry) => entry.key)).not.toContain("APP_URL");
    expect(drift).not.toContain("APP_URL");
  });

  it("reports a parameter that disagrees with the registry and keeps it out of the manifest", () => {
    const { runtimeFill, drift } = resolveBuildEnv({
      service: "app",
      env: "production",
      parameters: [
        param("INGESTION_CRYPTO_PROVIDER", "a-value-the-registry-never-names"),
      ],
      prefix: PREFIX,
    });
    expect(drift).toEqual(["INGESTION_CRYPTO_PROVIDER"]);
    expect(runtimeFill.map((entry) => entry.key)).not.toContain(
      "INGESTION_CRYPTO_PROVIDER",
    );
  });

  it("carries only static, non-secret values the service claims", () => {
    for (const env of ["production", "preview"] as const) {
      for (const service of ["app", "api", "mcp", "docs"] as const) {
        const { runtimeFill } = resolveBuildEnv({
          service,
          env,
          parameters: [],
          prefix: PREFIX,
        });
        for (const { key } of runtimeFill) {
          const meta = ENV_REGISTRY[key];
          expect(meta?.valueOrigin, key).toBe("static");
          expect(meta?.secret, key).toBe(false);
          expect(meta?.services, key).toContain(service);
        }
      }
    }
  });

  it("adds nothing for a key the registry leaves to Parameter Store in this environment", () => {
    // Staging builds as preview, and the registry sets no preview APP_URL:
    // staging's own parameter decides it.
    expect(staticValueFor("APP_URL", "preview")).toBeUndefined();
    const { runtimeFill } = resolveBuildEnv({
      service: "app",
      env: "preview",
      parameters: [],
      prefix: "/oxagen/staging",
    });
    expect(runtimeFill.map((entry) => entry.key)).not.toContain("APP_URL");
  });

  it("renders the fill as a JSON object of strings", () => {
    const rendered = renderRuntimeEnv([
      { key: "A", value: "one", secret: false, source: "registry" },
      { key: "B", value: "two words", secret: false, source: "registry" },
    ]);
    expect(JSON.parse(rendered)).toEqual({ A: "one", B: "two words" });
    expect(renderRuntimeEnv([])).toBe("{}\n");
  });
});
