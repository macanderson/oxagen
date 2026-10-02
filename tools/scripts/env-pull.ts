#!/usr/bin/env tsx
/**
 * env-pull.ts: write every `.env.local` from SSM Parameter Store (ADR-240).
 *
 * Usage:
 *   pnpm env:pull [--env development|staging] [--operator] [--check]
 *                 [--profile <name>] [--region <region>]
 *
 * It reads `/oxagen/development`, or `/oxagen/staging` with `--env staging`,
 * resolves the registry against it the way build-env.ts does for a build, and
 * writes the same set into every directory in ENV_TARGETS. The node starts
 * every container with every parameter (ADR-088), so each app gets the whole
 * set, not its own slice. `--operator` adds `/oxagen/operator` to the root file
 * only.
 *
 * Each file keeps what sits below its marker line (lib/local-env.ts). The
 * first pull over a file with no marker, which Vercel's pull wrote, copies it
 * to `.env.local.bak` and carries every key the pull does not supply below the
 * marker.
 *
 * `--check` writes nothing. It prints the key names each file would add,
 * change, or remove, and exits 1 when any file would change.
 *
 * Production never lands on a laptop, so `--env production` is refused.
 *
 * The AWS CLI finds its own credentials (`--profile`, `AWS_PROFILE`, an SSO
 * session, or an access key). This script reads no environment variable.
 */

import kleur from "kleur";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import { argv, exit } from "node:process";
import { parseArgs } from "node:util";
import { OPERATOR_PARAMETER_PREFIX, PARAMETER_PREFIXES } from "@oxagen/config";
import { ENV_TARGETS } from "./lib/env-targets";
import { formatError } from "./lib/format-error";
import { isEntrypoint } from "./lib/is-entrypoint.mjs";
import {
  diffEnvLocal,
  planEnvLocal,
  resolveLocalEnv,
  type LocalEnvName,
} from "./lib/local-env";
import { DEFAULT_REGION, readParameters } from "./lib/parameter-store";

export const PULL_USAGE =
  "Usage: pnpm env:pull [--env development|staging] [--operator] [--check] " +
  "[--profile <name>] [--region <region>]";

export interface PullOptions {
  /** The registry's name for the environment. */
  env: LocalEnvName;
  /** The name a person types, for messages: `development` or `staging`. */
  envFlag: "development" | "staging";
  operator: boolean;
  check: boolean;
  profile?: string;
  region: string;
}

export type ParsedArgs<T> =
  | { ok: true; options: T }
  | { ok: false; message: string };

/** `pnpm env:pull -- --check` hands the script a leading `--`. Drop it. */
export function withoutSeparator(args: readonly string[]): string[] {
  return args[0] === "--" ? args.slice(1) : [...args];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read the command line. Pure, so the refusals are tested. */
export function parsePullArgs(args: readonly string[]): ParsedArgs<PullOptions> {
  let flags: {
    env?: string;
    operator?: boolean;
    check?: boolean;
    profile?: string;
    region?: string;
  };
  try {
    flags = parseArgs({
      args: withoutSeparator(args),
      options: {
        env: { type: "string" },
        operator: { type: "boolean" },
        check: { type: "boolean" },
        profile: { type: "string" },
        region: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }

  let env: LocalEnvName;
  let envFlag: PullOptions["envFlag"];
  switch (flags.env) {
    case undefined:
    case "development":
      env = "development";
      envFlag = "development";
      break;
    case "staging":
    case "preview":
      env = "preview";
      envFlag = "staging";
      break;
    case "production":
      return {
        ok: false,
        message:
          "env:pull does not write production values to a laptop. To read " +
          "one value, run `aws ssm get-parameter --name " +
          `${PARAMETER_PREFIXES.production}/<KEY> --with-decryption\`.`,
      };
    default:
      return {
        ok: false,
        message: `--env must be development or staging, not ${flags.env}.`,
      };
  }

  if (flags.region === "") {
    return { ok: false, message: "--region needs a region name." };
  }
  if (flags.profile === "") {
    return { ok: false, message: "--profile needs a profile name." };
  }

  return {
    ok: true,
    options: {
      env,
      envFlag,
      operator: flags.operator ?? false,
      check: flags.check ?? false,
      profile: flags.profile,
      region: flags.region ?? DEFAULT_REGION,
    },
  };
}

/**
 * Write a file whole or not at all: a temporary file beside it, then a rename.
 * The file is mode 0600, since it holds credentials.
 */
function writeAtomically(file: string, text: string): void {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Copy the old file aside, mode 0600 even when the backup already existed. */
function writeBackup(file: string, text: string): void {
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function names(keys: readonly string[]): string {
  return keys.join(", ");
}

function usageError(message: string): never {
  console.error(kleur.red(`[env-pull] ${message}`));
  console.error(PULL_USAGE);
  exit(2);
}

async function main(): Promise<void> {
  const parsed = parsePullArgs(argv.slice(2));
  if (!parsed.ok) usageError(parsed.message);
  const { env, envFlag, operator, check, profile, region } = parsed.options;

  const root = resolve(process.cwd());
  const prefix = PARAMETER_PREFIXES[env];
  const aws = { profile, region };

  const sources = operator ? `${prefix} and ${OPERATOR_PARAMETER_PREFIX}` : prefix;
  console.log(kleur.cyan(`[env-pull] reading ${sources} in ${region}`));
  const parameters = await readParameters(prefix, aws);
  const operatorParameters = operator
    ? await readParameters(OPERATOR_PARAMETER_PREFIX, aws)
    : undefined;
  const resolved = resolveLocalEnv({
    env,
    parameters,
    prefix,
    operatorParameters,
  });

  let pending = 0;
  for (const target of ENV_TARGETS) {
    const file = resolve(root, target.dir, ".env.local");
    const label = relative(root, file);
    const isRoot = target.dir === ".";
    const values = isRoot
      ? [...resolved.values, ...resolved.operatorValues]
      : resolved.values;
    const source = isRoot && operatorParameters ? sources : prefix;
    const existing = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    const plan = planEnvLocal({ existing, source, values });

    if (check) {
      const { added, changed, removed } = diffEnvLocal(existing, plan.text);
      if (added.length + changed.length + removed.length === 0) {
        console.log(`[env-pull] ${label}: up to date`);
        continue;
      }
      pending++;
      console.log(
        kleur.yellow(
          `[env-pull] ${label}: ${added.length} to add, ` +
            `${changed.length} to change, ${removed.length} to remove`,
        ),
      );
      if (added.length > 0) console.log(`  add: ${names(added)}`);
      if (changed.length > 0) console.log(`  change: ${names(changed)}`);
      if (removed.length > 0) console.log(`  remove: ${names(removed)}`);
      continue;
    }

    if (plan.backup && existing !== undefined) {
      writeBackup(`${file}.bak`, existing);
    }
    writeAtomically(file, plan.text);
    console.log(kleur.green(`[env-pull] ${label}: ${values.length} values`));
    if (plan.backup) {
      console.log(`  The old file had no marker line. It is saved as ${label}.bak.`);
    }
    if (plan.carried.length > 0) {
      console.log(`  Kept below the marker: ${names(plan.carried)}`);
    }
    if (plan.overridden.length > 0) {
      console.log(
        `  Set below the marker, so the pulled value is not used: ${names(plan.overridden)}`,
      );
    }
  }

  // Names only. A value never reaches the terminal.
  if (resolved.missingRequired.length > 0) {
    console.warn(
      kleur.yellow(
        `[env-pull] required in ${envFlag} and missing: ` +
          `${names(resolved.missingRequired)}. No parameter under ${prefix} ` +
          "holds them and the registry has no static value. Save each one " +
          `with \`pnpm env:push <KEY> --env ${envFlag}\`, then pull again.`,
      ),
    );
  }
  if (resolved.drift.length > 0) {
    console.warn(
      kleur.yellow(
        `[env-pull] the store and the registry disagree: ` +
          `${names(resolved.drift)}. ${prefix} holds a different value than ` +
          "the registry's static one, and .env.local uses the registry's, as " +
          "a build does. Delete the parameter, or change the registry if the " +
          "parameter is right.",
      ),
    );
  }
  if (resolved.unknown.length > 0) {
    console.warn(
      kleur.yellow(
        `[env-pull] no registry key belongs at ${names(resolved.unknown)}. ` +
          "Either the registry does not list the key or it keeps the key in " +
          "another store. The pull skipped them. Add the key to " +
          "packages/config/src/registry.ts, or delete the parameter.",
      ),
    );
  }

  if (check) {
    if (pending > 0) {
      console.log(
        kleur.yellow(
          `[env-pull] ${pending} of ${ENV_TARGETS.length} files would change. ` +
            `Run \`pnpm env:pull${envFlag === "staging" ? " --env staging" : ""}` +
            `${operator ? " --operator" : ""}\` to write them.`,
        ),
      );
      exit(1);
    }
    console.log(kleur.green("[env-pull] every file is up to date"));
    return;
  }
  console.log(kleur.green("[env-pull] done"));
}

if (isEntrypoint(import.meta.url)) {
  await main().catch((error: unknown) => {
    console.error(kleur.red(`[env-pull] ${formatError(error)}`));
    exit(1);
  });
}
