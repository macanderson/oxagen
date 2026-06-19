import { describe, it, expect } from "vitest";
import { resolveIsLocalEnv, type LocalEnvSignals } from "./local-env";

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

  // The whole point of OXA-1752: deterministic local even when NODE_ENV hasn't
  // settled to 'development' yet (next dev boot race / tsx services).
  it("is true via OXAGEN_LOCAL_DEV='1' even when NODE_ENV looks like production", () => {
    expect(resolveIsLocalEnv({ ...base, nodeEnv: "production", localDevFlag: "1" })).toBe(true);
  });

  it("accepts OXAGEN_LOCAL_DEV='true' as well", () => {
    expect(resolveIsLocalEnv({ ...base, localDevFlag: "true" })).toBe(true);
  });

  it("is false in a plain production process", () => {
    expect(resolveIsLocalEnv({ ...base, nodeEnv: "production", vercelEnv: "production" })).toBe(false);
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

  it("is false when nothing signals local", () => {
    expect(resolveIsLocalEnv(base)).toBe(false);
  });
});
