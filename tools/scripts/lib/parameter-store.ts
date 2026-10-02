/**
 * parameter-store.ts: the AWS boundary for SSM Parameter Store (ADR-240), and
 * the pure helpers around it.
 *
 * Every call shells out to the AWS CLI v2, so the CLI's own credential chain
 * decides who is calling: `--profile`, `AWS_PROFILE`, an SSO session, or an
 * access key. Nothing here reads the environment itself, because env-check.ts
 * fails CI on a read the registry does not list.
 *
 * A value never goes on a command line, where the process list and shell
 * history can read it. `putParameter` writes the request to a file only this
 * user can read and hands the CLI its path.
 *
 * An error never carries the CLI's stdout. For a read, stdout holds decrypted
 * values. Only stderr, which names the failure and no value, reaches a message.
 */

import { execa } from "execa";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One parameter as `aws ssm get-parameters-by-path` reports it. */
export interface Parameter {
  Name: string;
  Value: string;
}

/** Every Oxagen parameter lives in us-east-1. */
export const DEFAULT_REGION = "us-east-1";

export interface AwsTarget {
  /** A named profile from `~/.aws/config`. Unset, the CLI picks its default. */
  profile?: string;
  region: string;
}

/** The largest value a Standard parameter holds. */
export const STANDARD_TIER_MAX_BYTES = 4096;

/** The largest value an Advanced parameter holds. */
export const ADVANCED_TIER_MAX_BYTES = 8192;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The variable name a parameter stands for: its path with the prefix
 * stripped, as build-env.ts strips it. Undefined for a parameter outside the
 * prefix, a nested path (`/oxagen/production/neo4j/password`), or a leaf that
 * is not a shell variable name. The registry only ever names leaves.
 */
export function leafName(prefix: string, name: string): string | undefined {
  const normalized = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  if (!name.startsWith(`${normalized}/`)) return undefined;
  const leaf = name.slice(normalized.length + 1);
  return IDENTIFIER.test(leaf) ? leaf : undefined;
}

/** The request `aws ssm put-parameter --cli-input-json` reads. */
export interface PutParameterInput {
  Name: string;
  Value: string;
  Type: "SecureString" | "String";
  Overwrite: true;
  Tier: "Standard" | "Advanced";
}

/**
 * Build the put-parameter request for one value. A value over 4096 bytes
 * needs the Advanced tier, and one over 8192 bytes fits no tier, so it throws.
 * The error names the parameter and the size, never the value.
 */
export function putParameterInput(
  name: string,
  value: string,
  secure: boolean,
): PutParameterInput {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > ADVANCED_TIER_MAX_BYTES) {
    throw new Error(
      `${name} is ${bytes} bytes, and a parameter holds at most ` +
        `${ADVANCED_TIER_MAX_BYTES}. Nothing was saved. Store a smaller ` +
        `value, such as the location of a file that holds this one.`,
    );
  }
  return {
    Name: name,
    Value: value,
    Type: secure ? "SecureString" : "String",
    Overwrite: true,
    Tier: bytes > STANDARD_TIER_MAX_BYTES ? "Advanced" : "Standard",
  };
}

function isParameter(item: unknown): item is Parameter {
  if (typeof item !== "object" || item === null) return false;
  const { Name, Value } = item as { Name?: unknown; Value?: unknown };
  return typeof Name === "string" && typeof Value === "string";
}

/**
 * Parse what `get-parameters-by-path` prints with the `--query` readParameters
 * passes. Empty output, or `null` from a query over no parameters, is an empty
 * list. The error for any other shape leaves the output out: it holds values.
 */
export function parseParameterList(stdout: string, prefix: string): Parameter[] {
  if (stdout.trim() === "") return [];
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error(
      `The AWS CLI printed output for ${prefix} that is not JSON. ` +
        `Update to AWS CLI v2 (\`brew install awscli\`) and run this again.`,
    );
  }
  if (data === null) return [];
  if (!Array.isArray(data)) {
    throw new Error(
      `The AWS CLI printed output for ${prefix} that is not a list of ` +
        `parameters. Update to AWS CLI v2 (\`brew install awscli\`) and run this again.`,
    );
  }
  const items: unknown[] = data;
  const parameters: Parameter[] = [];
  for (const item of items) {
    if (!isParameter(item)) {
      throw new Error(
        `The AWS CLI listed a parameter under ${prefix} without a string ` +
          `Name and Value. Update to AWS CLI v2 (\`brew install awscli\`) and run this again.`,
      );
    }
    parameters.push(item);
  }
  return parameters;
}

function withTarget(command: string[], target: AwsTarget): string[] {
  const args = [...command, "--region", target.region];
  if (target.profile) args.push("--profile", target.profile);
  return args;
}

/**
 * Run one AWS CLI command and return its stdout. `what` names the command in
 * an error. It must name no value.
 */
async function runAws(args: string[], what: string): Promise<string> {
  // An empty AWS_PAGER keeps CLI v2 from piping output through `less`.
  const result = await execa("aws", args, {
    reject: false,
    env: { AWS_PAGER: "" },
  });
  if (!result.failed) return String(result.stdout);

  const cause = result.cause as { code?: unknown } | undefined;
  if (result.code === "ENOENT" || cause?.code === "ENOENT") {
    throw new Error(
      "The AWS CLI is not installed. Install AWS CLI v2 with " +
        "`brew install awscli`, sign in with `aws configure sso` or " +
        "`aws configure`, and run this again.",
    );
  }
  const stderr = String(result.stderr).trim();
  const status =
    result.exitCode === undefined ? "" : ` with exit code ${result.exitCode}`;
  throw new Error(
    [
      `\`aws ${what}\` failed${status}.`,
      stderr || "The CLI printed no error.",
      "Run `aws sts get-caller-identity` to see which account and role the " +
        "CLI uses, sign in again if the session ended, and run this again.",
    ].join("\n"),
  );
}

/**
 * Every parameter under `prefix`, decrypted. The CLI follows the pages itself
 * and applies the query to the whole result.
 */
export async function readParameters(
  prefix: string,
  target: AwsTarget,
): Promise<Parameter[]> {
  const stdout = await runAws(
    withTarget(
      [
        "ssm",
        "get-parameters-by-path",
        "--path",
        prefix,
        "--recursive",
        "--with-decryption",
        "--output",
        "json",
        "--query",
        "Parameters[].{Name:Name,Value:Value}",
      ],
      target,
    ),
    `ssm get-parameters-by-path --path ${prefix}`,
  );
  return parseParameterList(stdout, prefix);
}

export interface PutParameterRequest extends AwsTarget {
  name: string;
  value: string;
  /** Save a SecureString. Otherwise a String. */
  secure: boolean;
}

/**
 * Create or overwrite one parameter. The request goes to the CLI as a file in
 * a fresh directory under the system temp directory. The directory is mode
 * 0700, the file 0600, and both are removed whether the call succeeds or not.
 */
export async function putParameter({
  name,
  value,
  secure,
  profile,
  region,
}: PutParameterRequest): Promise<Pick<PutParameterInput, "Type" | "Tier">> {
  const input = putParameterInput(name, value, secure);
  const dir = mkdtempSync(join(tmpdir(), "oxagen-env-push-"));
  try {
    chmodSync(dir, 0o700);
    const file = join(dir, "put-parameter.json");
    writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
    // `file://` is the AWS CLI's prefix for "read this path", not a URL, so
    // the path goes in as it is.
    await runAws(
      withTarget(
        ["ssm", "put-parameter", "--cli-input-json", `file://${file}`],
        { profile, region },
      ),
      `ssm put-parameter --name ${name}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { Type: input.Type, Tier: input.Tier };
}
