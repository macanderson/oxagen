/**
 * Unit tests for the AI Gateway key rotation lib: the command line, the token
 * file, the Vercel responses, the parameter names, and the message for a run
 * that stops partway. Nothing here reaches Vercel or AWS.
 */

import { describe, expect, it } from "vitest";
import {
  extractGatewayKey,
  gatewayKeyName,
  gatewayKeyParameter,
  maskSecret,
  parseRotateArgs,
  parseTokensFile,
  resolveTeam,
  rotationFailureMessage,
  tokenForSlug,
} from "./lib/rotate-ai-gateway-key";

describe("parseRotateArgs", () => {
  function refusal(args: string[]): string {
    const parsed = parseRotateArgs(args);
    if (parsed.ok) throw new Error(`expected ${args.join(" ")} to be refused`);
    return parsed.message;
  }

  function envsOf(args: string[]): string[] {
    const parsed = parseRotateArgs(args);
    if (!parsed.ok) throw new Error(`expected ${args.join(" ")} to parse`);
    const { options } = parsed;
    if (options.mode !== "rotate") {
      throw new Error(`expected ${args.join(" ")} to parse as a rotation`);
    }
    return options.envs;
  }

  it("reads a team slug and one environment", () => {
    expect(parseRotateArgs(["oxagen", "--env", "production"])).toEqual({
      ok: true,
      options: {
        mode: "rotate",
        slug: "oxagen",
        envs: ["production"],
        dryRun: false,
        profile: undefined,
        region: "us-east-1",
      },
    });
  });

  it("drops the separator pnpm passes on", () => {
    expect(envsOf(["--", "oxagen", "--env", "staging"])).toEqual(["staging"]);
  });

  it("reads --dry-run, --profile, and --region", () => {
    expect(
      parseRotateArgs([
        "oxagen",
        "--env",
        "staging",
        "--dry-run",
        "--profile",
        "oxagen-admin",
        "--region",
        "us-west-2",
      ]),
    ).toEqual({
      ok: true,
      options: {
        mode: "rotate",
        slug: "oxagen",
        envs: ["staging"],
        dryRun: true,
        profile: "oxagen-admin",
        region: "us-west-2",
      },
    });
  });

  it("reads repeated --env flags and comma lists, in a fixed order", () => {
    expect(
      envsOf(["oxagen", "--env", "production", "--env", "development, staging"]),
    ).toEqual(["development", "staging", "production"]);
  });

  it("reads preview as staging and drops repeats", () => {
    expect(envsOf(["oxagen", "--env", "preview,staging", "--env", "staging"])).toEqual([
      "staging",
    ]);
  });

  it("reads --init on its own", () => {
    expect(parseRotateArgs(["--init"])).toEqual({
      ok: true,
      options: { mode: "init" },
    });
    expect(refusal(["--init", "oxagen"])).toContain("--init runs on its own");
    expect(refusal(["--init", "--env", "development"])).toContain(
      "--init runs on its own",
    );
    expect(refusal(["--init", "--dry-run"])).toContain("--init runs on its own");
    expect(refusal(["--init", "--profile", "oxagen-admin"])).toContain(
      "--init runs on its own",
    );
    expect(refusal(["--init", "--region", "us-west-2"])).toContain(
      "--init runs on its own",
    );
  });

  it("refuses a missing or doubled team slug", () => {
    expect(refusal(["--env", "production"])).toContain("Name the Vercel team slug");
    expect(refusal(["oxagen", "manderson", "--env", "production"])).toContain(
      "Name one team slug",
    );
  });

  it("refuses a missing, unknown, empty, or operator environment", () => {
    expect(refusal(["oxagen"])).toContain("--env is required");
    expect(refusal(["oxagen", "--env", "prod"])).toContain("not prod");
    expect(refusal(["oxagen", "--env", "staging,,production"])).toContain(
      "empty name",
    );
    expect(refusal(["oxagen", "--env", "operator"])).toContain(
      "AI_GATEWAY_API_KEY has one value per environment",
    );
  });

  it("refuses an empty --profile or --region", () => {
    expect(refusal(["oxagen", "--env", "staging", "--region="])).toContain(
      "--region needs a region name",
    );
    expect(refusal(["oxagen", "--env", "staging", "--profile="])).toContain(
      "--profile needs a profile name",
    );
  });

  it("refuses the retired --skip-redeploy flag", () => {
    expect(refusal(["oxagen", "--env", "production", "--skip-redeploy"])).toContain(
      "--skip-redeploy",
    );
  });
});

describe("gatewayKeyParameter", () => {
  it("names the parameter under each environment's prefix", () => {
    expect(gatewayKeyParameter("development")).toBe(
      "/oxagen/development/AI_GATEWAY_API_KEY",
    );
    expect(gatewayKeyParameter("staging")).toBe(
      "/oxagen/staging/AI_GATEWAY_API_KEY",
    );
    expect(gatewayKeyParameter("production")).toBe(
      "/oxagen/production/AI_GATEWAY_API_KEY",
    );
  });
});

describe("gatewayKeyName", () => {
  it("names the environment and the UTC day", () => {
    expect(gatewayKeyName("production", new Date("2026-10-02T23:30:00Z"))).toBe(
      "oxagen-production-2026-10-02",
    );
  });
});

describe("rotationFailureMessage", () => {
  it("names what was saved, the stranded key, and the command that finishes the job", () => {
    const message = rotationFailureMessage({
      slug: "oxagen",
      saved: ["development"],
      failed: "staging",
      strandedKey: "oxagen-staging-2026-10-02",
      rerun: ["staging", "production"],
      cause: "`aws ssm put-parameter` failed with exit code 254.",
    });
    expect(message).toContain("The rotation stopped at staging.");
    expect(message).toContain("`aws ssm put-parameter` failed");
    expect(message).toContain("already hold a new key: development.");
    expect(message).toContain(
      "Vercel holds a new key named oxagen-staging-2026-10-02",
    );
    expect(message).toContain(
      "`pnpm vercel:rotate-ai-key oxagen --env staging,production`",
    );
  });

  it("says nothing was saved and names no key when Vercel created none", () => {
    const message = rotationFailureMessage({
      slug: "oxagen",
      saved: [],
      failed: "development",
      rerun: ["development"],
      cause: "Vercel answered POST /v1/api-keys with 403: forbidden",
    });
    expect(message).toContain("No environment got a new key.");
    expect(message).not.toContain("Vercel holds a new key");
    expect(message).toContain("--env development`");
  });
});

describe("parseTokensFile", () => {
  it("accepts a bare array", () => {
    const entries = parseTokensFile('[{"slug":"oxagen","token":"tok_a"}]');
    expect(entries).toEqual([{ slug: "oxagen", token: "tok_a" }]);
  });

  it("accepts a { tokens: [...] } wrapper", () => {
    const entries = parseTokensFile(
      '{"tokens":[{"slug":"manderson","token":"tok_b"},{"slug":"oxagen","token":"tok_c"}]}',
    );
    expect(entries).toHaveLength(2);
    expect(entries[1]).toEqual({ slug: "oxagen", token: "tok_c" });
  });

  it("rejects invalid JSON", () => {
    expect(() => parseTokensFile("{nope")).toThrow(/not valid JSON/);
  });

  it("rejects non-array shapes", () => {
    expect(() => parseTokensFile('{"tokens":"x"}')).toThrow(/must be an array/);
  });

  it("rejects entries missing slug or token", () => {
    expect(() => parseTokensFile('[{"token":"t"}]')).toThrow(
      /missing a non-empty "slug"/,
    );
    expect(() => parseTokensFile('[{"slug":"oxagen","token":""}]')).toThrow(
      /"oxagen".*missing a non-empty "token"/,
    );
  });
});

describe("tokenForSlug", () => {
  const entries = [
    { slug: "manderson", token: "tok_m" },
    { slug: "oxagen", token: "tok_o" },
  ];

  it("returns the matching entry", () => {
    expect(tokenForSlug(entries, "oxagen").token).toBe("tok_o");
  });

  it("throws listing known slugs when absent", () => {
    expect(() => tokenForSlug(entries, "acme")).toThrow(
      /"manderson", "oxagen"/,
    );
  });
});

describe("extractGatewayKey", () => {
  it("prefers well-known field names", () => {
    expect(extractGatewayKey({ key: "vck_direct", note: "vck_decoy" })).toBe(
      "vck_direct",
    );
  });

  it("finds a nested key under an envelope object", () => {
    expect(
      extractGatewayKey({ apiKey: { id: "ak_1", token: "vck_nested" } }),
    ).toBe("vck_nested");
  });

  it("falls back to a recursive vck_ scan", () => {
    expect(
      extractGatewayKey({ data: { items: [{ opaque: "vck_found" }] } }),
    ).toBe("vck_found");
  });

  it("returns null when no key material is present", () => {
    expect(extractGatewayKey({ id: "ak_1", name: "my-key" })).toBeNull();
    expect(extractGatewayKey(null)).toBeNull();
  });
});

describe("resolveTeam", () => {
  it("resolves a slug to its team id", () => {
    const teams = {
      teams: [
        { id: "team_1", slug: "manderson" },
        { id: "team_2", slug: "oxagen" },
      ],
    };
    expect(resolveTeam(teams, "oxagen")).toEqual({
      id: "team_2",
      slug: "oxagen",
    });
  });

  it("throws with accessible slugs when the token cannot see the team", () => {
    const teams = { teams: [{ id: "team_1", slug: "manderson" }] };
    expect(() => resolveTeam(teams, "oxagen")).toThrow(
      /It can reach these teams: manderson\./,
    );
  });

  it("handles a malformed response", () => {
    expect(() => resolveTeam({}, "oxagen")).toThrow(
      /It can reach these teams: \(none\)\./,
    );
  });
});

describe("maskSecret", () => {
  it("shows only a short prefix and the length", () => {
    const masked = maskSecret("vck_1234567890abcdef");
    expect(masked).toBe("vck_1234… (20 chars)");
    expect(masked).not.toContain("90abcdef");
  });
});
