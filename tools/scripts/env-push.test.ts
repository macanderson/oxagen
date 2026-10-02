/**
 * Unit tests for env-push.ts: where the registry lets a key go, what `--from`
 * would write, and the command line. Nothing here reaches AWS.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CI_REGISTRY, ENV_REGISTRY } from "@oxagen/config";
import type { CiVarMeta, EnvVarMeta } from "@oxagen/config";
import {
  afterSaveLines,
  parsePushArgs,
  parsePushTarget,
  planPush,
  pushRefusal,
  SKIP_REASONS,
  stripTrailingNewline,
  targetPrefix,
} from "./env-push";
import type { Parameter } from "./lib/parameter-store";

function meta(overrides: Partial<EnvVarMeta>): EnvVarMeta {
  return {
    group: "Test",
    description: "A fixture for env-push.test.ts.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    ...overrides,
  };
}

// One key per store, added to the live registry for this file only (vitest
// gives each test file its own module graph). The registry may not declare a
// key in every store yet.
const FIXTURES: Record<string, EnvVarMeta> = {
  PUSH_TEST_SECRET: meta({ secret: true, services: ["api", "app", "mcp"] }),
  PUSH_TEST_PLAIN: meta({ services: ["api"] }),
  PUSH_TEST_PUBLIC: meta({ clientExposed: true, services: ["app"] }),
  PUSH_TEST_STATIC: meta({ valueOrigin: "static", staticValue: { "*": "x" } }),
  PUSH_TEST_OPERATOR: meta({ secret: true, store: "operator" }),
  PUSH_TEST_CI: meta({ secret: true, store: "ci" }),
  PUSH_TEST_CI_ENVIRONMENT: meta({ secret: true, store: "ci" }),
  PUSH_TEST_SHELL: meta({ store: "shell" }),
};

const CI_FIXTURES: Record<string, CiVarMeta> = {
  PUSH_TEST_CI_ENVIRONMENT: {
    kind: "secret",
    environment: "production",
    description: "A fixture for env-push.test.ts.",
    refresh: { how: "A fixture." },
  },
};

beforeAll(() => {
  Object.assign(ENV_REGISTRY, FIXTURES);
  Object.assign(CI_REGISTRY, CI_FIXTURES);
});

afterAll(() => {
  for (const key of Object.keys(FIXTURES)) delete ENV_REGISTRY[key];
  for (const key of Object.keys(CI_FIXTURES)) delete CI_REGISTRY[key];
});

describe("parsePushTarget and targetPrefix", () => {
  it("maps each target to its prefix", () => {
    expect(targetPrefix("development")).toBe("/oxagen/development");
    expect(targetPrefix("staging")).toBe("/oxagen/staging");
    expect(targetPrefix("production")).toBe("/oxagen/production");
    expect(targetPrefix("operator")).toBe("/oxagen/operator");
  });

  it("reads preview as staging and refuses anything else", () => {
    expect(parsePushTarget("preview")).toBe("staging");
    expect(parsePushTarget("development")).toBe("development");
    expect(parsePushTarget("prod")).toBeUndefined();
    expect(parsePushTarget(undefined)).toBeUndefined();
  });
});

describe("pushRefusal", () => {
  it("lets an environment key go to every environment, and not to operator", () => {
    for (const target of ["development", "staging", "production"] as const) {
      expect(pushRefusal("PUSH_TEST_SECRET", target)).toBeUndefined();
    }
    expect(pushRefusal("PUSH_TEST_SECRET", "operator")).toContain(
      "--env development, staging, or production",
    );
  });

  it("lets an operator key go only to operator", () => {
    expect(pushRefusal("PUSH_TEST_OPERATOR", "operator")).toBeUndefined();
    expect(pushRefusal("PUSH_TEST_OPERATOR", "development")).toContain(
      "--env operator",
    );
  });

  it("sends a static key to the registry file", () => {
    expect(pushRefusal("PUSH_TEST_STATIC", "development")).toContain(
      "packages/config/src/registry.ts",
    );
  });

  it("refuses a key the registry does not list", () => {
    expect(pushRefusal("NOT_A_REGISTRY_KEY", "development")).toContain(
      "is not in the registry",
    );
  });

  it("gives a CI key the gh command that saves it", () => {
    expect(pushRefusal("PUSH_TEST_CI", "development")).toContain(
      "`gh secret set PUSH_TEST_CI`",
    );
    expect(pushRefusal("PUSH_TEST_CI_ENVIRONMENT", "production")).toContain(
      "`gh secret set PUSH_TEST_CI_ENVIRONMENT --env production`",
    );
  });

  it("says a shell key is kept in no store", () => {
    expect(pushRefusal("PUSH_TEST_SHELL", "development")).toContain(
      "not kept in any store",
    );
  });
});

describe("planPush", () => {
  const DEV = "/oxagen/development";
  const current: Parameter[] = [
    { Name: `${DEV}/PUSH_TEST_PLAIN`, Value: "old" },
    { Name: `${DEV}/DATABASE_URL`, Value: "postgres://same" },
    { Name: `${DEV}/nested/PUSH_TEST_SECRET`, Value: "ignored" },
  ];

  it("sorts every key into new, changed, unchanged, or a skip reason", () => {
    const plan = planPush({
      target: "development",
      current,
      entries: {
        PUSH_TEST_SECRET: "s3cret",
        PUSH_TEST_PLAIN: "new",
        DATABASE_URL: "postgres://same",
        PUSH_TEST_PUBLIC: "",
        PUSH_TEST_STATIC: "x",
        PUSH_TEST_CI: "ci",
        PUSH_TEST_SHELL: "shell",
        PUSH_TEST_OPERATOR: "op",
        NOT_A_REGISTRY_KEY: "x",
      },
    });

    expect(plan.added).toEqual(["PUSH_TEST_SECRET"]);
    expect(plan.changed).toEqual(["PUSH_TEST_PLAIN"]);
    expect(plan.unchanged).toEqual(["DATABASE_URL"]);
    expect(plan.skipped).toEqual({
      unregistered: ["NOT_A_REGISTRY_KEY"],
      static: ["PUSH_TEST_STATIC"],
      ci: ["PUSH_TEST_CI"],
      shell: ["PUSH_TEST_SHELL"],
      "other-store": ["PUSH_TEST_OPERATOR"],
      empty: ["PUSH_TEST_PUBLIC"],
    });
    expect(plan.writes).toEqual([
      {
        key: "PUSH_TEST_PLAIN",
        name: `${DEV}/PUSH_TEST_PLAIN`,
        value: "new",
        secure: false,
      },
      {
        key: "PUSH_TEST_SECRET",
        name: `${DEV}/PUSH_TEST_SECRET`,
        value: "s3cret",
        secure: true,
      },
    ]);
  });

  it("writes operator keys under /oxagen/operator and skips environment keys there", () => {
    const plan = planPush({
      target: "operator",
      current: [],
      entries: { PUSH_TEST_OPERATOR: "op", PUSH_TEST_SECRET: "s" },
    });
    expect(plan.writes).toEqual([
      {
        key: "PUSH_TEST_OPERATOR",
        name: "/oxagen/operator/PUSH_TEST_OPERATOR",
        value: "op",
        secure: true,
      },
    ]);
    expect(plan.skipped["other-store"]).toEqual(["PUSH_TEST_SECRET"]);
  });

  it("writes under /oxagen/staging for staging", () => {
    const plan = planPush({
      target: "staging",
      current: [],
      entries: { PUSH_TEST_PLAIN: "v" },
    });
    expect(plan.writes.map((w) => w.name)).toEqual([
      "/oxagen/staging/PUSH_TEST_PLAIN",
    ]);
  });

  it("names a label for every skip reason", () => {
    const reasons = SKIP_REASONS.map(([reason]) => reason).sort();
    const plan = planPush({ target: "development", current: [], entries: {} });
    expect(reasons).toEqual(Object.keys(plan.skipped).sort());
  });
});

describe("afterSaveLines", () => {
  it("points a development value at env:pull", () => {
    expect(afterSaveLines("PUSH_TEST_SECRET", "development")).toEqual([
      "Run `pnpm env:pull` to write it into each .env.local.",
    ]);
  });

  it("points an operator value at env:pull --operator", () => {
    expect(afterSaveLines("PUSH_TEST_OPERATOR", "operator")[0]).toContain(
      "pnpm env:pull --operator",
    );
  });

  it("names the services a deployed value reaches", () => {
    expect(afterSaveLines("PUSH_TEST_SECRET", "production")).toEqual([
      "It reaches api, app, and mcp the next time each one starts, at a deploy or a restart.",
    ]);
    expect(afterSaveLines("PUSH_TEST_PLAIN", "staging")).toEqual([
      "It reaches api the next time it starts, at a deploy or a restart.",
    ]);
  });

  it("says a client value needs a rebuild", () => {
    const lines = afterSaveLines("PUSH_TEST_PUBLIC", "production");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("rebuild");
  });
});

describe("stripTrailingNewline", () => {
  it("drops exactly one trailing line break", () => {
    expect(stripTrailingNewline("value\n")).toBe("value");
    expect(stripTrailingNewline("value\r\n")).toBe("value");
    expect(stripTrailingNewline("value\n\n")).toBe("value\n");
    expect(stripTrailingNewline("value")).toBe("value");
    expect(stripTrailingNewline("")).toBe("");
    expect(stripTrailingNewline("-----BEGIN KEY-----\nabc\n-----END KEY-----\n")).toBe(
      "-----BEGIN KEY-----\nabc\n-----END KEY-----",
    );
  });
});

describe("parsePushArgs", () => {
  function refusal(args: string[]): string {
    const parsed = parsePushArgs(args);
    if (parsed.ok) throw new Error(`expected ${args.join(" ")} to be refused`);
    return parsed.message;
  }

  it("reads one key", () => {
    expect(parsePushArgs(["STRIPE_SECRET_KEY", "--env", "development"])).toEqual({
      ok: true,
      options: {
        mode: "key",
        key: "STRIPE_SECRET_KEY",
        target: "development",
        profile: undefined,
        region: "us-east-1",
      },
    });
  });

  it("reads a file plan, and --apply", () => {
    expect(
      parsePushArgs([
        "--from",
        ".env.local",
        "--env",
        "operator",
        "--apply",
        "--profile",
        "oxagen",
        "--region",
        "us-west-2",
      ]),
    ).toEqual({
      ok: true,
      options: {
        mode: "file",
        from: ".env.local",
        target: "operator",
        apply: true,
        profile: "oxagen",
        region: "us-west-2",
      },
    });
  });

  it("refuses --from for production", () => {
    expect(refusal(["--from", ".env.local", "--env", "production"])).toContain(
      "does not write production",
    );
  });

  it("lets one production key through", () => {
    const parsed = parsePushArgs(["DATABASE_URL", "--env", "production"]);
    expect(parsed.ok && parsed.options.target).toBe("production");
  });

  it("refuses a missing, unknown, or doubled input", () => {
    expect(refusal(["--env", "development"])).toContain("Name a key");
    expect(refusal(["KEY", "--from", "f", "--env", "development"])).toContain(
      "not both",
    );
    expect(refusal(["A", "B", "--env", "development"])).toContain("one key");
    expect(refusal(["KEY"])).toContain("--env is required");
    expect(refusal(["KEY", "--env", "prod"])).toContain("not prod");
    expect(refusal(["KEY", "--env", "development", "--apply"])).toContain(
      "--apply goes with --from",
    );
    expect(refusal(["KEY", "--env", "development", "--value", "x"])).toMatch(
      /value/,
    );
  });
});
