/**
 * Unit tests for env-pull.ts's command line. The pull itself reads AWS and
 * writes files; its decisions are tested in local-env.test.ts.
 */

import { describe, expect, it } from "vitest";
import { parsePullArgs, withoutSeparator } from "./env-pull";

function options(args: string[]) {
  const parsed = parsePullArgs(args);
  if (!parsed.ok) throw new Error(`expected ${args.join(" ")} to parse: ${parsed.message}`);
  return parsed.options;
}

function refusal(args: string[]): string {
  const parsed = parsePullArgs(args);
  if (parsed.ok) throw new Error(`expected ${args.join(" ")} to be refused`);
  return parsed.message;
}

describe("parsePullArgs", () => {
  it("pulls development into every file by default", () => {
    expect(options([])).toEqual({
      env: "development",
      envFlag: "development",
      operator: false,
      check: false,
      profile: undefined,
      region: "us-east-1",
    });
  });

  it("maps staging, and its registry name preview, to the preview environment", () => {
    expect(options(["--env", "staging"])).toMatchObject({
      env: "preview",
      envFlag: "staging",
    });
    expect(options(["--env", "preview"])).toMatchObject({
      env: "preview",
      envFlag: "staging",
    });
  });

  it("reads every flag", () => {
    expect(
      options([
        "--operator",
        "--check",
        "--profile",
        "oxagen",
        "--region",
        "us-west-2",
      ]),
    ).toEqual({
      env: "development",
      envFlag: "development",
      operator: true,
      check: true,
      profile: "oxagen",
      region: "us-west-2",
    });
  });

  it("refuses production and says how to read one value instead", () => {
    const message = refusal(["--env", "production"]);
    expect(message).toContain("does not write production values to a laptop");
    expect(message).toContain(
      "aws ssm get-parameter --name /oxagen/production/<KEY> --with-decryption",
    );
  });

  it("refuses an environment it does not know", () => {
    expect(refusal(["--env", "prod"])).toContain("development or staging");
  });

  it("refuses an unknown flag, a positional, and an empty value", () => {
    expect(refusal(["--force"])).toMatch(/force/);
    expect(refusal(["development"])).toBeTruthy();
    expect(refusal(["--region", ""])).toContain("--region");
    expect(refusal(["--profile", ""])).toContain("--profile");
  });

  it("accepts the separator pnpm can pass through", () => {
    expect(options(["--", "--check"]).check).toBe(true);
  });
});

describe("withoutSeparator", () => {
  it("drops only a leading --", () => {
    expect(withoutSeparator(["--", "--check"])).toEqual(["--check"]);
    expect(withoutSeparator(["--check"])).toEqual(["--check"]);
    expect(withoutSeparator(["KEY", "--", "x"])).toEqual(["KEY", "--", "x"]);
  });
});
