/**
 * Unit tests for lib/local-env.ts: what `pnpm env:pull` writes into each
 * `.env.local` (ADR-240), and how a pull keeps the developer's own lines.
 */

import { parseEnv } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENV_REGISTRY } from "@oxagen/config";
import type { EnvVarMeta } from "@oxagen/config";
import {
  diffEnvLocal,
  formatDotenvValue,
  LOCAL_OVERRIDES_MARKER,
  planEnvLocal,
  renderEnvLocal,
  resolveLocalEnv,
  splitEnvLocal,
} from "./lib/local-env";
import type { Parameter } from "./lib/parameter-store";

const DEV = "/oxagen/development";
const STAGING = "/oxagen/staging";
const OPERATOR = "/oxagen/operator";

function param(prefix: string, key: string, value: string): Parameter {
  return { Name: `${prefix}/${key}`, Value: value };
}

function meta(overrides: Partial<EnvVarMeta>): EnvVarMeta {
  return {
    group: "Test",
    description: "A fixture for local-env.test.ts.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    ...overrides,
  };
}

// The registry may not declare a key in every store yet, so these fixtures pin
// one key per store. They are added to the live registry object for this file
// only: vitest gives each test file its own module graph.
const FIXTURES: Record<string, EnvVarMeta> = {
  LOCAL_ENV_TEST_ENVIRONMENT: meta({
    secret: true,
    services: ["api"],
    requiredIn: ["development"],
  }),
  LOCAL_ENV_TEST_STATIC: meta({
    services: ["api"],
    requiredIn: ["development", "preview"],
    valueOrigin: "static",
    // No preview value: build-env.ts falls back to the parameter there.
    staticValue: { development: "static-dev-value" },
  }),
  LOCAL_ENV_TEST_OPERATOR: meta({ secret: true, store: "operator" }),
  LOCAL_ENV_TEST_CI: meta({ secret: true, store: "ci" }),
  LOCAL_ENV_TEST_SHELL: meta({ store: "shell" }),
};

beforeAll(() => {
  Object.assign(ENV_REGISTRY, FIXTURES);
});

afterAll(() => {
  for (const key of Object.keys(FIXTURES)) delete ENV_REGISTRY[key];
});

describe("resolveLocalEnv", () => {
  it("takes a static value from the registry", () => {
    const { values } = resolveLocalEnv({
      env: "development",
      parameters: [],
      prefix: DEV,
    });
    expect(values.find((v) => v.key === "NODE_ENV")).toEqual({
      key: "NODE_ENV",
      value: "development",
      secret: false,
      source: "registry",
    });
    expect(values.find((v) => v.key === "LOCAL_ENV_TEST_STATIC")).toMatchObject(
      { value: "static-dev-value", source: "registry" },
    );
  });

  it("takes an environment value from the parameter, and marks it secret", () => {
    const { values, missingRequired } = resolveLocalEnv({
      env: "development",
      parameters: [
        param(DEV, "LOCAL_ENV_TEST_ENVIRONMENT", "from-the-store"),
        param(DEV, "DATABASE_URL", "postgres://localhost:5433/oxagen"),
      ],
      prefix: DEV,
    });
    expect(values.find((v) => v.key === "LOCAL_ENV_TEST_ENVIRONMENT")).toEqual({
      key: "LOCAL_ENV_TEST_ENVIRONMENT",
      value: "from-the-store",
      secret: true,
      source: "parameter-store",
    });
    expect(values.find((v) => v.key === "DATABASE_URL")).toMatchObject({
      value: "postgres://localhost:5433/oxagen",
      source: "parameter-store",
    });
    expect(missingRequired).not.toContain("LOCAL_ENV_TEST_ENVIRONMENT");
    expect(missingRequired).not.toContain("DATABASE_URL");
  });

  it("lists a required key with no value as missing, and writes nothing for it", () => {
    const { values, missingRequired } = resolveLocalEnv({
      env: "development",
      parameters: [],
      prefix: DEV,
    });
    expect(missingRequired).toContain("LOCAL_ENV_TEST_ENVIRONMENT");
    expect(missingRequired).toContain("DATABASE_URL");
    expect(values.map((v) => v.key)).not.toContain("LOCAL_ENV_TEST_ENVIRONMENT");
  });

  it("keeps registry order, the order .env.example uses", () => {
    const keys = resolveLocalEnv({
      env: "development",
      parameters: [param(DEV, "DATABASE_URL", "postgres://x")],
      prefix: DEV,
    }).values.map((v) => v.key);
    const registryOrder = Object.keys(ENV_REGISTRY).filter((k) => keys.includes(k));
    expect(keys).toEqual(registryOrder);
  });

  it("keeps the registry's value and reports drift when a parameter disagrees", () => {
    const { values, drift, unknown } = resolveLocalEnv({
      env: "development",
      parameters: [param(DEV, "NODE_ENV", "production")],
      prefix: DEV,
    });
    expect(values.find((v) => v.key === "NODE_ENV")?.value).toBe("development");
    expect(drift).toEqual(["NODE_ENV"]);
    // A static key under the environment prefix is drift, not misplaced.
    expect(unknown).toEqual([]);
    // Names only: the parameter's value appears in no list.
    expect(JSON.stringify({ drift, unknown })).not.toContain("production");
  });

  it("reports no drift when a parameter repeats the registry's value", () => {
    const { drift } = resolveLocalEnv({
      env: "development",
      parameters: [param(DEV, "NODE_ENV", "development")],
      prefix: DEV,
    });
    expect(drift).toEqual([]);
  });

  it("falls back to the parameter for a static key with no value in this environment", () => {
    const withParameter = resolveLocalEnv({
      env: "preview",
      parameters: [param(STAGING, "LOCAL_ENV_TEST_STATIC", "staging-value")],
      prefix: STAGING,
    });
    expect(
      withParameter.values.find((v) => v.key === "LOCAL_ENV_TEST_STATIC"),
    ).toMatchObject({ value: "staging-value", source: "parameter-store" });
    expect(withParameter.drift).not.toContain("LOCAL_ENV_TEST_STATIC");
    expect(withParameter.unknown).toEqual([]);

    const without = resolveLocalEnv({
      env: "preview",
      parameters: [],
      prefix: STAGING,
    });
    expect(without.missingRequired).toContain("LOCAL_ENV_TEST_STATIC");
  });

  it("writes operator values only from the operator prefix, and only when read", () => {
    const operatorParameters = [
      param(OPERATOR, "LOCAL_ENV_TEST_OPERATOR", "npm-token"),
    ];
    const read = resolveLocalEnv({
      env: "development",
      parameters: [],
      prefix: DEV,
      operatorParameters,
    });
    expect(read.operatorValues).toEqual([
      {
        key: "LOCAL_ENV_TEST_OPERATOR",
        value: "npm-token",
        secret: true,
        source: "parameter-store",
      },
    ]);
    expect(read.values.map((v) => v.key)).not.toContain("LOCAL_ENV_TEST_OPERATOR");
    expect(read.unknown).toEqual([]);

    const notRead = resolveLocalEnv({
      env: "development",
      parameters: [],
      prefix: DEV,
    });
    expect(notRead.operatorValues).toEqual([]);
  });

  it("never writes a ci or shell key, and names a parameter that holds one", () => {
    const { values, unknown } = resolveLocalEnv({
      env: "development",
      parameters: [
        param(DEV, "LOCAL_ENV_TEST_CI", "ci-secret"),
        param(DEV, "LOCAL_ENV_TEST_SHELL", "shell-value"),
      ],
      prefix: DEV,
    });
    const keys = values.map((v) => v.key);
    expect(keys).not.toContain("LOCAL_ENV_TEST_CI");
    expect(keys).not.toContain("LOCAL_ENV_TEST_SHELL");
    expect(unknown).toEqual([
      `${DEV}/LOCAL_ENV_TEST_CI`,
      `${DEV}/LOCAL_ENV_TEST_SHELL`,
    ]);
  });

  it("names parameters that are in the wrong prefix or in no registry entry", () => {
    const { unknown } = resolveLocalEnv({
      env: "development",
      parameters: [
        param(DEV, "NOT_A_REGISTRY_KEY", "x"),
        param(DEV, "LOCAL_ENV_TEST_OPERATOR", "x"),
        // A nested path names no variable and is left alone, as build-env.ts does.
        param(DEV, "neo4j/password", "x"),
      ],
      prefix: DEV,
      operatorParameters: [
        param(OPERATOR, "LOCAL_ENV_TEST_ENVIRONMENT", "x"),
        param(OPERATOR, "ANOTHER_UNLISTED_KEY", "x"),
      ],
    });
    expect(unknown).toEqual([
      `${DEV}/NOT_A_REGISTRY_KEY`,
      `${DEV}/LOCAL_ENV_TEST_OPERATOR`,
      `${OPERATOR}/LOCAL_ENV_TEST_ENVIRONMENT`,
      `${OPERATOR}/ANOTHER_UNLISTED_KEY`,
    ]);
  });
});

describe("formatDotenvValue", () => {
  /** Write one line and read it back the way Node's --env-file does. */
  function roundTrip(value: string): string | undefined {
    const parsed = parseEnv(`KEY=${formatDotenvValue("KEY", value)}\n`);
    return parsed.KEY;
  }

  it("writes a plain value bare", () => {
    expect(formatDotenvValue("K", "postgres://oxagen:oxagen@localhost:5433/oxagen")).toBe(
      "postgres://oxagen:oxagen@localhost:5433/oxagen",
    );
    expect(formatDotenvValue("K", "")).toBe("");
  });

  it.each([
    ["a URL with a query string", "https://example.com/cb?a=b&c=d"],
    ["spaces and a hash", "two words # not a comment"],
    ["a dollar sign", "pa$$word$HOME"],
    ["compact JSON", '{"api.githubcopilot.com":{"client_id":"abc","n":1}}'],
    [
      "a PEM block",
      "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA==\n-----END PRIVATE KEY-----\n",
    ],
    [
      "a PEM with its newlines escaped, as Parameter Store holds some",
      "-----BEGIN PRIVATE KEY-----\\nMC4CAQAwBQYDK2VwBCIEIA==\\n-----END PRIVATE KEY-----\\n",
    ],
    ["an apostrophe", "O'Brien's key"],
    ["the empty string", ""],
    ["leading and trailing spaces", "  padded  "],
    ["a backslash before a line break", "line one\\\nline two"],
  ])("reads back %s unchanged", (_label, value) => {
    expect(roundTrip(value)).toBe(value);
  });

  it("quotes each kind of value the way the comment says", () => {
    expect(formatDotenvValue("K", "https://example.com/cb?a=b&c=d")).toBe(
      "'https://example.com/cb?a=b&c=d'",
    );
    expect(formatDotenvValue("K", "a\nb")).toBe('"a\\nb"');
    expect(formatDotenvValue("K", "O'Brien")).toBe(`"O'Brien"`);
  });

  it("reads back a whole file of awkward values with no bleed between lines", () => {
    const values: Record<string, string> = {
      URL: "https://example.com/cb?a=b&c=d",
      HASH: "two words # not a comment",
      DOLLAR: "pa$$word",
      JSON_VALUE: '{"a":"b"}',
      PEM: "-----BEGIN KEY-----\nabc\n-----END KEY-----",
      EMPTY: "",
      BARE: "plain-value",
    };
    const text = Object.entries(values)
      .map(([key, value]) => `${key}=${formatDotenvValue(key, value)}`)
      .join("\n");
    expect(parseEnv(`${text}\n`)).toEqual(values);
  });

  it("throws on a value no quoting holds, naming the key and not the value", () => {
    const value = `it's a "both quotes" value`;
    expect(() => formatDotenvValue("MIXED_QUOTES", value)).toThrow(/MIXED_QUOTES/);
    try {
      formatDotenvValue("MIXED_QUOTES", value);
    } catch (error) {
      expect((error as Error).message).not.toContain("both quotes");
    }
  });

  it("throws on a carriage return, which Node drops before it parses", () => {
    expect(() => formatDotenvValue("CR", "a\rb")).toThrow(/CR/);
  });

  it("throws on a multi-line value that also holds a double quote", () => {
    expect(() => formatDotenvValue("PRETTY_JSON", '{\n  "a": 1\n}')).toThrow(
      /PRETTY_JSON/,
    );
  });

  it("throws on a multi-line value with a literal backslash-n of its own", () => {
    expect(() => formatDotenvValue("ESCAPED", "it's\\n\nhere")).toThrow(/ESCAPED/);
  });
});

describe("renderEnvLocal", () => {
  const values = [
    { key: "ALPHA", value: "one" },
    { key: "BETA", value: "two words" },
  ];

  it("writes the header, the values, the marker, then the override block", () => {
    const text = renderEnvLocal({
      source: DEV,
      values,
      overrides: "LOCAL_ONLY=1\n",
    });
    const lines = text.split("\n");
    expect(lines.slice(0, 3).every((line) => line.startsWith("# "))).toBe(true);
    expect(lines[0]).toContain(DEV);
    expect(lines[0]).toContain("ADR-240");
    expect(lines.slice(3)).toEqual([
      "",
      "ALPHA=one",
      "BETA='two words'",
      "",
      LOCAL_OVERRIDES_MARKER,
      "LOCAL_ONLY=1",
      "",
    ]);
  });

  it("leaves out a key the override block sets, so the override wins", () => {
    const text = renderEnvLocal({
      source: DEV,
      values,
      overrides: "ALPHA=mine\n",
    });
    expect(text).not.toContain("ALPHA=one");
    expect(parseEnv(text)).toEqual({ ALPHA: "mine", BETA: "two words" });
  });

  it("writes the same bytes for the same input, with no timestamp", () => {
    const input = { source: DEV, values, overrides: "" };
    expect(renderEnvLocal(input)).toBe(renderEnvLocal(input));
    expect(renderEnvLocal(input)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("ends an override block with a line break", () => {
    const text = renderEnvLocal({ source: DEV, values: [], overrides: "X=1" });
    expect(text.endsWith(`${LOCAL_OVERRIDES_MARKER}\nX=1\n`)).toBe(true);
  });

  it("writes no blank value section when there are no values", () => {
    const text = renderEnvLocal({ source: DEV, values: [], overrides: "" });
    expect(text.split("\n").slice(3)).toEqual(["", LOCAL_OVERRIDES_MARKER, ""]);
  });

  it("uses only ASCII, so no em dash slips into a file", () => {
    const text = renderEnvLocal({ source: DEV, values, overrides: "" });
    expect(/^[\x20-\x7e\n]*$/.test(text)).toBe(true);
  });
});

describe("splitEnvLocal", () => {
  it("returns no override block for a file with no marker", () => {
    expect(splitEnvLocal("A=1\n")).toEqual({
      generated: "A=1\n",
      overrides: undefined,
    });
  });

  it("returns what sits below the marker, as it is", () => {
    const overrides = "# my notes\nDATABASE_URL=postgres://elsewhere\n\n";
    const text = renderEnvLocal({
      source: DEV,
      values: [{ key: "A", value: "1" }],
      overrides,
    });
    const split = splitEnvLocal(text);
    expect(split.overrides).toBe(overrides);
    expect(split.generated).toContain("A=1");
    expect(split.generated).not.toContain(LOCAL_OVERRIDES_MARKER);
  });

  it("returns an empty block when nothing follows the marker", () => {
    expect(splitEnvLocal(`A=1\n${LOCAL_OVERRIDES_MARKER}\n`).overrides).toBe("");
    expect(splitEnvLocal(`A=1\n${LOCAL_OVERRIDES_MARKER}`).overrides).toBe("");
  });
});

describe("planEnvLocal", () => {
  const values = [
    { key: "DATABASE_URL", value: "postgres://pulled" },
    { key: "NODE_ENV", value: "development" },
  ];

  it("writes a new file with an empty override block", () => {
    const plan = planEnvLocal({ existing: undefined, source: DEV, values });
    expect(plan.backup).toBe(false);
    expect(plan.carried).toEqual([]);
    expect(plan.overridden).toEqual([]);
    expect(plan.text.endsWith(`${LOCAL_OVERRIDES_MARKER}\n`)).toBe(true);
  });

  it("keeps the override block of a file that has a marker", () => {
    const first = planEnvLocal({ existing: undefined, source: DEV, values });
    const edited = `${first.text}DATABASE_URL=postgres://mine\n`;
    const plan = planEnvLocal({
      existing: edited,
      source: DEV,
      values: [...values, { key: "NEW_KEY", value: "new" }],
    });
    expect(plan.backup).toBe(false);
    expect(plan.carried).toEqual([]);
    expect(plan.overridden).toEqual(["DATABASE_URL"]);
    expect(splitEnvLocal(plan.text).overrides).toBe(
      "DATABASE_URL=postgres://mine\n",
    );
    expect(parseEnv(plan.text)).toEqual({
      DATABASE_URL: "postgres://mine",
      NODE_ENV: "development",
      NEW_KEY: "new",
    });
  });

  it("is stable: pulling over its own output changes nothing", () => {
    const first = planEnvLocal({ existing: undefined, source: DEV, values });
    const second = planEnvLocal({ existing: first.text, source: DEV, values });
    expect(second.text).toBe(first.text);
  });

  it("carries a Vercel-era file's own keys below the marker and asks for a backup", () => {
    const vercelEra = [
      "# Created by Vercel CLI",
      'DATABASE_URL="postgres://vercel"',
      'NODE_ENV="development"',
      'VERCEL_OIDC_TOKEN="eyJ.token"',
      'MY_LOCAL_FLAG="on"',
      'PEM_KEY="-----BEGIN KEY-----\\nabc\\n-----END KEY-----"',
      "",
    ].join("\n");
    const plan = planEnvLocal({ existing: vercelEra, source: DEV, values });

    expect(plan.backup).toBe(true);
    expect(plan.carried).toEqual(["MY_LOCAL_FLAG", "PEM_KEY", "VERCEL_OIDC_TOKEN"]);

    const below = parseEnv(splitEnvLocal(plan.text).overrides ?? "");
    expect(Object.keys(below).sort()).toEqual(plan.carried);

    expect(parseEnv(plan.text)).toEqual({
      DATABASE_URL: "postgres://pulled",
      NODE_ENV: "development",
      MY_LOCAL_FLAG: "on",
      PEM_KEY: "-----BEGIN KEY-----\nabc\n-----END KEY-----",
      VERCEL_OIDC_TOKEN: "eyJ.token",
    });
  });

  it("asks for a backup but carries nothing when the old file holds only pulled keys", () => {
    const plan = planEnvLocal({
      existing: 'DATABASE_URL="postgres://old"\n',
      source: DEV,
      values,
    });
    expect(plan.backup).toBe(true);
    expect(plan.carried).toEqual([]);
    expect(splitEnvLocal(plan.text).overrides).toBe("");
  });
});

describe("diffEnvLocal", () => {
  it("lists every key as added when there is no file", () => {
    expect(diffEnvLocal(undefined, "B=2\nA=1\n")).toEqual({
      added: ["A", "B"],
      changed: [],
      removed: [],
    });
  });

  it("names added, changed, and removed keys", () => {
    expect(diffEnvLocal("A=1\nB=2\nC=3\n", "A=1\nB=20\nD=4\n")).toEqual({
      added: ["D"],
      changed: ["B"],
      removed: ["C"],
    });
  });

  it("ignores comments, order, and quoting that do not change a value", () => {
    expect(
      diffEnvLocal("# old header\nB='two'\nA=1\n", "# new header\nA=1\nB=two\n"),
    ).toEqual({ added: [], changed: [], removed: [] });
  });

  it("returns names, never values", () => {
    const diff = diffEnvLocal("SECRET=old-secret\n", "SECRET=new-secret\n");
    expect(JSON.stringify(diff)).not.toContain("old-secret");
    expect(JSON.stringify(diff)).not.toContain("new-secret");
    expect(diff.changed).toEqual(["SECRET"]);
  });
});
