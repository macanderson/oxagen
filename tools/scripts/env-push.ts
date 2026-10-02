#!/usr/bin/env tsx
/**
 * env-push.ts: save values to SSM Parameter Store (ADR-240).
 *
 * Usage:
 *   pnpm env:push <KEY> --env development|staging|production|operator
 *                 [--profile <name>] [--region <region>]
 *   pnpm env:push --from <dotenv file> --env development|staging|operator
 *                 [--apply] [--profile <name>] [--region <region>]
 *
 * One key: the value comes from stdin when stdin is not a terminal, so a file
 * saves as it is (`pnpm env:push GITHUB_APP_PRIVATE_KEY --env production <
 * key.pem`). In a terminal it comes from a prompt that does not echo. One
 * trailing line break is dropped. The value never goes on a command line,
 * where shell history and the process list can read it.
 *
 * The registry decides where a key may go. An `environment` key goes under an
 * environment's prefix and an `operator` key under `/oxagen/operator`. Any
 * other key is refused with the place it belongs. A key the registry marks
 * secret is saved as a SecureString.
 *
 * `--from` reads a dotenv file and saves every key that belongs in the target,
 * which is how a working `.env.local` seeds a prefix. Without `--apply` it
 * prints the plan and writes nothing. Production is refused there: production
 * changes go one key at a time.
 *
 * The AWS CLI finds its own credentials (`--profile`, `AWS_PROFILE`, an SSO
 * session, or an access key). This script reads no environment variable.
 */

import kleur from "kleur";
import { existsSync, readFileSync } from "node:fs";
import { argv, exit, stderr, stdin } from "node:process";
import { parseArgs, parseEnv } from "node:util";
import {
  ciSaveCommand,
  ENV_REGISTRY,
  OPERATOR_PARAMETER_PREFIX,
  PARAMETER_PREFIXES,
  storeOf,
} from "@oxagen/config";
import type { ValueStore } from "@oxagen/config";
import { withoutSeparator, type ParsedArgs } from "./env-pull";
import { formatError } from "./lib/format-error";
import { isEntrypoint } from "./lib/is-entrypoint.mjs";
import {
  DEFAULT_REGION,
  leafName,
  putParameter,
  putParameterInput,
  readParameters,
  type AwsTarget,
  type Parameter,
} from "./lib/parameter-store";

export const PUSH_USAGE = [
  "Usage: pnpm env:push <KEY> --env development|staging|production|operator " +
    "[--profile <name>] [--region <region>]",
  "       pnpm env:push --from <dotenv file> --env development|staging|operator " +
    "[--apply] [--profile <name>] [--region <region>]",
].join("\n");

/** Where a push writes. `staging` is the registry's `preview`. */
export type PushTarget = "development" | "staging" | "production" | "operator";

/** Read `--env`. `preview` is accepted for `staging`. */
export function parsePushTarget(value: string | undefined): PushTarget | undefined {
  switch (value) {
    case "development":
    case "staging":
    case "production":
    case "operator":
      return value;
    case "preview":
      return "staging";
    default:
      return undefined;
  }
}

/** The Parameter Store prefix a target writes under. */
export function targetPrefix(target: PushTarget): string {
  switch (target) {
    case "development":
      return PARAMETER_PREFIXES.development;
    case "staging":
      return PARAMETER_PREFIXES.preview;
    case "production":
      return PARAMETER_PREFIXES.production;
    case "operator":
      return OPERATOR_PARAMETER_PREFIX;
  }
}

function targetStore(target: PushTarget): ValueStore {
  return target === "operator" ? "operator" : "environment";
}

/**
 * Why one key may not go to this target, or undefined when it may. Each
 * reason says where the key belongs instead.
 */
export function pushRefusal(key: string, target: PushTarget): string | undefined {
  const store = storeOf(key);
  switch (store) {
    case undefined:
      return (
        `${key} is not in the registry. Add it to ` +
        "packages/config/src/registry.ts, then push it."
      );
    case "registry":
      return (
        `${key} is a static value in the registry, and no parameter holds ` +
        "it. Change it in packages/config/src/registry.ts."
      );
    case "ci":
      return (
        `${key} is kept in GitHub Actions, not Parameter Store. Save it from ` +
        `a checkout with \`${ciSaveCommand(key) ?? `gh secret set ${key}`}\`.`
      );
    case "shell":
      return (
        `${key} is not kept in any store. Set it in your shell for the ` +
        "command that reads it."
      );
    case "environment":
      return target === "operator"
        ? `${key} has one value per environment. Push it with --env ` +
            "development, staging, or production."
        : undefined;
    case "operator":
      return target === "operator"
        ? undefined
        : `${key} is an operator value. Push it with --env operator.`;
  }
}

/** "a", "a and b", "a, b, and c". */
function listNames(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** What to do after a key is saved, one sentence a line. */
export function afterSaveLines(key: string, target: PushTarget): string[] {
  if (target === "development") {
    return ["Run `pnpm env:pull` to write it into each .env.local."];
  }
  if (target === "operator") {
    return ["Run `pnpm env:pull --operator` to write it into the root .env.local."];
  }
  const meta = ENV_REGISTRY[key];
  const services = meta?.services ?? [];
  const reach =
    services.length === 0
      ? "The registry lists no service that reads it."
      : services.length === 1
        ? `It reaches ${listNames(services)} the next time it starts, at a deploy or a restart.`
        : `It reaches ${listNames(services)} the next time each one starts, at a deploy or a restart.`;
  const lines = [reach];
  if (meta?.clientExposed) {
    lines.push(
      "It is compiled into the client bundle, so it takes effect only after a rebuild.",
    );
  }
  return lines;
}

/** Drop exactly one trailing `\n` or `\r\n`, the one `echo` or a file adds. */
export function stripTrailingNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

export type SkipReason =
  | "unregistered"
  | "static"
  | "ci"
  | "shell"
  | "other-store"
  | "empty";

/** Each skip reason as the plan prints it, in the order it prints them. */
export const SKIP_REASONS: ReadonlyArray<readonly [SkipReason, string]> = [
  ["unregistered", "not in the registry"],
  ["static", "static values in the registry"],
  ["ci", "kept in GitHub Actions"],
  ["shell", "kept in no store"],
  ["other-store", "kept under another prefix"],
  ["empty", "empty"],
];

export interface PushWrite {
  key: string;
  /** The full parameter name. */
  name: string;
  value: string;
  secure: boolean;
}

export interface PushPlan {
  /** The new and changed keys, in key order. */
  writes: PushWrite[];
  added: string[];
  changed: string[];
  unchanged: string[];
  skipped: Record<SkipReason, string[]>;
}

export interface PlanPushInput {
  /** The dotenv file, parsed. */
  entries: Readonly<Record<string, string | undefined>>;
  target: PushTarget;
  /** Every parameter under the target's prefix now. */
  current: readonly Parameter[];
}

function skipReason(
  store: ValueStore | undefined,
  wanted: ValueStore,
  value: string,
): SkipReason | undefined {
  if (store === undefined) return "unregistered";
  if (store === "registry") return "static";
  if (store === "ci") return "ci";
  if (store === "shell") return "shell";
  if (store !== wanted) return "other-store";
  if (value === "") return "empty";
  return undefined;
}

/**
 * Decide what `--from` writes: every key whose store matches the target and
 * whose value is not empty, compared with what the prefix holds now. Pure, so
 * the selection is tested without AWS. Names only in every list but `writes`.
 */
export function planPush({ entries, target, current }: PlanPushInput): PushPlan {
  const prefix = targetPrefix(target);
  const wanted = targetStore(target);
  const stored = new Map<string, string>();
  for (const { Name, Value } of current) {
    const leaf = leafName(prefix, Name);
    if (leaf !== undefined) stored.set(leaf, Value);
  }

  const plan: PushPlan = {
    writes: [],
    added: [],
    changed: [],
    unchanged: [],
    skipped: {
      unregistered: [],
      static: [],
      ci: [],
      shell: [],
      "other-store": [],
      empty: [],
    },
  };

  for (const key of Object.keys(entries).sort()) {
    const value = entries[key] ?? "";
    const reason = skipReason(storeOf(key), wanted, value);
    if (reason !== undefined) {
      plan.skipped[reason].push(key);
      continue;
    }
    const before = stored.get(key);
    if (before === value) {
      plan.unchanged.push(key);
      continue;
    }
    if (before === undefined) plan.added.push(key);
    else plan.changed.push(key);
    plan.writes.push({
      key,
      name: `${prefix}/${key}`,
      value,
      secure: ENV_REGISTRY[key]?.secret ?? true,
    });
  }
  return plan;
}

interface KeyCommand {
  mode: "key";
  key: string;
  target: PushTarget;
}

interface FileCommand {
  mode: "file";
  from: string;
  target: Exclude<PushTarget, "production">;
  apply: boolean;
}

export type PushCommand = (KeyCommand | FileCommand) & AwsTarget;

/** Read the command line. Pure, so the refusals are tested. */
export function parsePushArgs(args: readonly string[]): ParsedArgs<PushCommand> {
  let flags: {
    env?: string;
    from?: string;
    apply?: boolean;
    profile?: string;
    region?: string;
  };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: withoutSeparator(args),
      options: {
        env: { type: "string" },
        from: { type: "string" },
        apply: { type: "boolean" },
        profile: { type: "string" },
        region: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
    flags = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (positionals.length > 1) {
    return { ok: false, message: "Name one key at a time." };
  }
  const key = positionals[0];
  if (key !== undefined && flags.from !== undefined) {
    return { ok: false, message: "Name a key or pass --from, not both." };
  }
  if (key === undefined && flags.from === undefined) {
    return { ok: false, message: "Name a key, or pass --from <dotenv file>." };
  }
  if (flags.env === undefined) {
    return {
      ok: false,
      message: "--env is required: development, staging, production, or operator.",
    };
  }
  const target = parsePushTarget(flags.env);
  if (target === undefined) {
    return {
      ok: false,
      message:
        "--env must be development, staging, production, or operator, " +
        `not ${flags.env}.`,
    };
  }
  if (flags.region === "") {
    return { ok: false, message: "--region needs a region name." };
  }
  if (flags.profile === "") {
    return { ok: false, message: "--profile needs a profile name." };
  }
  const aws: AwsTarget = {
    profile: flags.profile,
    region: flags.region ?? DEFAULT_REGION,
  };

  if (key !== undefined) {
    if (flags.apply) {
      return {
        ok: false,
        message: "--apply goes with --from. One key is saved without it.",
      };
    }
    return { ok: true, options: { mode: "key", key, target, ...aws } };
  }

  if (target === "production") {
    return {
      ok: false,
      message:
        "env:push --from does not write production. Push each production " +
        "key on its own with `pnpm env:push <KEY> --env production`.",
    };
  }
  return {
    ok: true,
    options: {
      mode: "file",
      from: flags.from ?? "",
      target,
      apply: flags.apply ?? false,
      ...aws,
    },
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Prompt on the terminal without echoing what is typed. Enter finishes,
 * Backspace deletes, and Ctrl-C cancels. A multi-line value, such as a PEM
 * key, goes in on stdin instead.
 */
function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolvePrompt, rejectPrompt) => {
    const typed: string[] = [];
    const finish = (error?: Error): void => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
      if (error) rejectPrompt(error);
      else resolvePrompt(typed.join(""));
    };
    const onData = (data: string): void => {
      for (const char of data) {
        if (char === "\r" || char === "\n" || char === "\u0004") {
          finish();
          return;
        }
        if (char === "\u0003") {
          finish(new Error("Cancelled. Nothing was saved."));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          typed.pop();
          continue;
        }
        typed.push(char);
      }
    };
    stderr.write(prompt);
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

function refuse(message: string, code: number): never {
  console.error(kleur.red(`[env-push] ${message}`));
  exit(code);
}

async function pushKey(command: KeyCommand & AwsTarget): Promise<void> {
  const { key, target, profile, region } = command;
  const refusal = pushRefusal(key, target);
  if (refusal !== undefined) refuse(refusal, 1);

  const name = `${targetPrefix(target)}/${key}`;
  const raw = stdin.isTTY
    ? await promptHidden(`Value for ${name} (input is hidden): `)
    : await readStdin();
  const value = stripTrailingNewline(raw);
  if (value === "") refuse("The value is empty. Nothing was saved.", 1);

  const secure = ENV_REGISTRY[key]?.secret ?? true;
  const { Type, Tier } = await putParameter({
    name,
    value,
    secure,
    profile,
    region,
  });
  console.log(kleur.green(`Saved ${name} (${Type}).`));
  if (Tier === "Advanced") {
    console.log(
      "The value is over 4096 bytes, so it is an Advanced parameter, which AWS bills monthly.",
    );
  }
  for (const line of afterSaveLines(key, target)) console.log(line);
}

async function pushFile(command: FileCommand & AwsTarget): Promise<void> {
  const { from, target, apply, profile, region } = command;
  if (!existsSync(from)) {
    refuse(`No file at ${from}. Pass the path of a dotenv file.`, 2);
  }
  const entries = parseEnv(readFileSync(from, "utf8"));
  const prefix = targetPrefix(target);
  const current = await readParameters(prefix, { profile, region });
  const plan = planPush({ entries, target, current });

  // Names only. A value never reaches the terminal.
  for (const [reason, label] of SKIP_REASONS) {
    const keys = plan.skipped[reason];
    if (keys.length > 0) {
      console.log(kleur.dim(`Skipped, ${label}: ${keys.join(", ")}`));
    }
  }
  console.log(`New under ${prefix}: ${plan.added.join(", ") || "none"}`);
  console.log(`Changed: ${plan.changed.join(", ") || "none"}`);
  console.log(`Unchanged: ${plan.unchanged.join(", ") || "none"}`);

  if (plan.writes.length === 0) {
    console.log(kleur.green(`${prefix} already holds every value. Nothing to write.`));
    return;
  }
  if (!apply) {
    console.log(
      kleur.yellow(
        `Nothing was written. Run again with --apply to save ` +
          `${plan.writes.length} parameters.`,
      ),
    );
    return;
  }

  // Check every size before the first write, so an oversized value cannot
  // stop the run halfway.
  for (const write of plan.writes) {
    putParameterInput(write.name, write.value, write.secure);
  }
  for (const write of plan.writes) {
    const { Type } = await putParameter({
      name: write.name,
      value: write.value,
      secure: write.secure,
      profile,
      region,
    });
    console.log(kleur.green(`Saved ${write.name} (${Type}).`));
  }
  if (target === "development") {
    console.log("Run `pnpm env:pull` to write them into each .env.local.");
  } else if (target === "operator") {
    console.log("Run `pnpm env:pull --operator` to write them into the root .env.local.");
  } else {
    console.log("Each service reads them the next time it starts.");
  }
}

async function main(): Promise<void> {
  const parsed = parsePushArgs(argv.slice(2));
  if (!parsed.ok) {
    console.error(kleur.red(`[env-push] ${parsed.message}`));
    console.error(PUSH_USAGE);
    exit(2);
  }
  const command = parsed.options;
  if (command.mode === "key") await pushKey(command);
  else await pushFile(command);
}

if (isEntrypoint(import.meta.url)) {
  await main().catch((error: unknown) => {
    console.error(kleur.red(`[env-push] ${formatError(error)}`));
    exit(1);
  });
}
