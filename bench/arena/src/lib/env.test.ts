import { afterEach, describe, expect, it } from "vitest";

import {
  PNPM_UNKNOWN_NPM_CONFIG_KEYS,
  sanitizedEnv,
  scrubProcessEnv,
} from "./env";

const OFFENDER = "npm_config_manage_package_manager_versions";

// Next augments NodeJS.ProcessEnv to require NODE_ENV, so minimal test fixtures
// need a cast to stand in as an environment. Runtime shape is exactly as written.
const asEnv = (o: Record<string, string>): NodeJS.ProcessEnv =>
  o as NodeJS.ProcessEnv;

describe("PNPM_UNKNOWN_NPM_CONFIG_KEYS", () => {
  it("lists the pnpm key npm rejects", () => {
    expect(PNPM_UNKNOWN_NPM_CONFIG_KEYS).toContain(OFFENDER);
  });
});

describe("sanitizedEnv", () => {
  it("removes the npm-unknown pnpm key", () => {
    const out = sanitizedEnv(asEnv({ [OFFENDER]: "false", PATH: "/usr/bin" }));
    expect(out).not.toHaveProperty(OFFENDER);
    expect(out.PATH).toBe("/usr/bin");
  });

  it("keeps legitimate npm_config_* keys (e.g. user_agent)", () => {
    const out = sanitizedEnv(
      asEnv({
        npm_config_user_agent: "pnpm/11.7.0",
        [OFFENDER]: "false",
      }),
    );
    expect(out.npm_config_user_agent).toBe("pnpm/11.7.0");
    expect(out).not.toHaveProperty(OFFENDER);
  });

  it("strips the key regardless of case", () => {
    const out = sanitizedEnv(
      asEnv({ NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS: "1" }),
    );
    expect(Object.keys(out)).toHaveLength(0);
  });

  it("does not mutate the input object", () => {
    const input = asEnv({ [OFFENDER]: "false" });
    sanitizedEnv(input);
    expect(input).toHaveProperty(OFFENDER);
  });

  it("defaults to process.env and does not mutate it", () => {
    process.env[OFFENDER] = "false";
    const out = sanitizedEnv();
    expect(out).not.toHaveProperty(OFFENDER);
    // the source process.env is left untouched by the pure variant
    expect(process.env[OFFENDER]).toBe("false");
    Reflect.deleteProperty(process.env, OFFENDER);
  });

  it("is a no-op when the key is absent", () => {
    const out = sanitizedEnv(asEnv({ PATH: "/bin", HOME: "/home/x" }));
    expect(out).toEqual({ PATH: "/bin", HOME: "/home/x" });
  });
});

describe("scrubProcessEnv", () => {
  afterEach(() => {
    Reflect.deleteProperty(process.env, OFFENDER);
  });

  it("removes the offending key from process.env in place", () => {
    process.env[OFFENDER] = "false";
    scrubProcessEnv();
    expect(process.env[OFFENDER]).toBeUndefined();
  });

  it("leaves other env vars intact", () => {
    process.env[OFFENDER] = "false";
    const before = process.env.PATH;
    scrubProcessEnv();
    expect(process.env.PATH).toBe(before);
  });
});
