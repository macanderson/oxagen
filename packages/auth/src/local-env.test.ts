import { describe, it, expect } from "vitest";
import {
  isEmailVerificationRequired,
  resolveIsLocalEnv,
  type LocalEnvSignals,
} from "./local-env";

const base: LocalEnvSignals = {
  nodeEnv: undefined,
  vercel: undefined,
  vercelEnv: undefined,
  e2eTest: undefined,
  localDevFlag: undefined,
};

describe("resolveIsLocalEnv", () => {
  it("is true when NODE_ENV is development", () => {
    expect(resolveIsLocalEnv({ ...base, nodeEnv: "development" })).toBe(true);
  });

  it("is true when NODE_ENV is test", () => {
    expect(resolveIsLocalEnv({ ...base, nodeEnv: "test" })).toBe(true);
  });

  it("is true when VERCEL_ENV is development", () => {
    expect(resolveIsLocalEnv({ ...base, vercelEnv: "development" })).toBe(true);
  });

  it("is true under the E2E harness", () => {
    expect(resolveIsLocalEnv({ ...base, e2eTest: "true" })).toBe(true);
  });

  // Deterministic local detection even when NODE_ENV hasn't settled to
  // 'development' yet (next dev boot race / tsx services).
  it("is true via OXAGEN_LOCAL_DEV='1' even when NODE_ENV looks like production", () => {
    expect(
      resolveIsLocalEnv({ ...base, nodeEnv: "production", localDevFlag: "1" }),
    ).toBe(true);
  });

  it("accepts OXAGEN_LOCAL_DEV='true' as well", () => {
    expect(resolveIsLocalEnv({ ...base, localDevFlag: "true" })).toBe(true);
  });

  it("is false in a plain production process", () => {
    expect(
      resolveIsLocalEnv({
        ...base,
        nodeEnv: "production",
        vercelEnv: "production",
      }),
    ).toBe(false);
  });

  // Defense in depth: the local flag must NEVER relax a real Vercel deployment,
  // even if it somehow leaked into a deployed env file.
  it("ignores OXAGEN_LOCAL_DEV on a real Vercel deployment", () => {
    expect(
      resolveIsLocalEnv({
        ...base,
        nodeEnv: "production",
        vercel: "1",
        vercelEnv: "production",
        localDevFlag: "1",
      }),
    ).toBe(false);
  });

  // E2E_TEST is a harness signal, never a deployment one — a leaked E2E_TEST=true
  // in a real Vercel env must NOT relax production auth controls.
  it("ignores E2E_TEST on a real Vercel deployment", () => {
    expect(
      resolveIsLocalEnv({
        ...base,
        nodeEnv: "production",
        vercel: "1",
        vercelEnv: "production",
        e2eTest: "true",
      }),
    ).toBe(false);
  });

  it("is false when nothing signals local", () => {
    expect(resolveIsLocalEnv(base)).toBe(false);
  });
});

describe("isEmailVerificationRequired", () => {
  // The helper must mirror !resolveIsLocalEnv(...) exactly — it's the predicate
  // the API /health gate uses to decide whether to require SMTP_*. Any drift
  // between these and the auth-config branch lets prod sign-in silently break.
  it("is false on a plain local box (NODE_ENV=development)", () => {
    expect(isEmailVerificationRequired({ NODE_ENV: "development" })).toBe(
      false,
    );
  });

  it("is false under the E2E harness", () => {
    expect(isEmailVerificationRequired({ E2E_TEST: "true" })).toBe(false);
  });

  it("is false when OXAGEN_LOCAL_DEV is set on a non-Vercel host", () => {
    expect(
      isEmailVerificationRequired({
        NODE_ENV: "production",
        OXAGEN_LOCAL_DEV: "1",
      }),
    ).toBe(false);
  });

  it("is true on a real Vercel production deployment", () => {
    expect(
      isEmailVerificationRequired({
        NODE_ENV: "production",
        VERCEL: "1",
        VERCEL_ENV: "production",
      }),
    ).toBe(true);
  });

  it("is true on a real Vercel preview deployment", () => {
    expect(
      isEmailVerificationRequired({
        NODE_ENV: "production",
        VERCEL: "1",
        VERCEL_ENV: "preview",
      }),
    ).toBe(true);
  });

  it("ignores OXAGEN_LOCAL_DEV on a real Vercel deployment", () => {
    expect(
      isEmailVerificationRequired({
        NODE_ENV: "production",
        VERCEL: "1",
        VERCEL_ENV: "production",
        OXAGEN_LOCAL_DEV: "1",
      }),
    ).toBe(true);
  });

  it("defaults to reading process.env when no env is passed", () => {
    // Smoke-test the no-arg overload — it should resolve without throwing
    // regardless of host shape; the value depends on the test runner env
    // (NODE_ENV=test on vitest) so we just assert it returns a boolean.
    expect(typeof isEmailVerificationRequired()).toBe("boolean");
  });
});
