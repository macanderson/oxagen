// secrets.test.ts — the guard that keeps a leaked API key out of
// bench.benchmark_run.config/.conditions.

import { describe, expect, it } from "vitest";
import { assertNoSecretValues } from "./secrets";

describe("assertNoSecretValues", () => {
  it("allows an env var NAME under a secret-shaped key", () => {
    expect(() =>
      assertNoSecretValues({ apiKeyEnv: "AI_GATEWAY_API_KEY" }),
    ).not.toThrow();
    expect(() =>
      assertNoSecretValues({ token_env: "GITHUB_TOKEN" }),
    ).not.toThrow();
  });

  it("allows ordinary non-secret-shaped keys with any string value", () => {
    expect(() =>
      assertNoSecretValues({
        models: "anthropic/claude-fable-5",
        effort: "xhigh",
      }),
    ).not.toThrow();
  });

  it("allows an empty string under a secret-shaped key", () => {
    expect(() => assertNoSecretValues({ apiKey: "" })).not.toThrow();
  });

  it("throws when a secret-shaped key holds a lowercase (non env-var-name) value", () => {
    expect(() =>
      assertNoSecretValues({ apiKey: "sk-ant-abc123def456" }),
    ).toThrow(/likely secret/);
  });

  it("throws for password/secret/token/credential key variants", () => {
    expect(() => assertNoSecretValues({ password: "hunter2" })).toThrow(
      /likely secret/,
    );
    expect(() => assertNoSecretValues({ secret: "shh-dont-tell" })).toThrow(
      /likely secret/,
    );
    expect(() => assertNoSecretValues({ userToken: "abc.def.ghi" })).toThrow(
      /likely secret/,
    );
    expect(() =>
      assertNoSecretValues({ dbCredential: "postgres://u:p@h" }),
    ).toThrow(/likely secret/);
  });

  it("is case-insensitive on the key name", () => {
    expect(() => assertNoSecretValues({ API_KEY: "sk-live-xyz" })).toThrow(
      /likely secret/,
    );
  });

  it("recurses into nested plain objects and reports the dotted path", () => {
    expect(() =>
      assertNoSecretValues({ auth: { apiKey: "sk-ant-nested" } }),
    ).toThrow(/auth\.apiKey/);
  });

  it("does not descend into arrays (no false positive on a list of task ids)", () => {
    expect(() =>
      assertNoSecretValues({
        taskIds: ["django__django-11099", "django__django-11095"],
      }),
    ).not.toThrow();
  });

  it("ignores non-string values under a secret-shaped key", () => {
    expect(() =>
      assertNoSecretValues({ apiKeyRotationDays: 30 }),
    ).not.toThrow();
    expect(() => assertNoSecretValues({ hasSecret: true })).not.toThrow();
  });
});
