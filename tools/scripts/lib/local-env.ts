/**
 * local-env.ts: what `pnpm env:pull` writes into each `.env.local` (ADR-240),
 * and how a pull keeps the lines a developer adds by hand.
 *
 * Pure. The Parameter Store snapshot comes in as data, so every decision here
 * is tested without AWS.
 *
 * Values follow build-env.ts, so a laptop runs what a build would:
 *   1. the registry's static value, when it has one for this environment;
 *   2. otherwise the parameter under the environment's prefix.
 * Operator values come from `/oxagen/operator`, and only when the caller read
 * it. A `ci` or `shell` variable is never written: no parameter holds it.
 *
 * A file has two parts. A pull rewrites everything above
 * `LOCAL_OVERRIDES_MARKER` and keeps everything below it as it is. A key set
 * below the marker wins, because the part above leaves that key out.
 */

import { parseEnv } from "node:util";
import {
  ENV_REGISTRY,
  OPERATOR_PARAMETER_PREFIX,
  staticValueFor,
  storeOf,
} from "@oxagen/config";
import type { EnvName, ValueStore } from "@oxagen/config";
import { leafName, type Parameter } from "./parameter-store";

/** The environments a laptop may pull. Production never lands on one. */
export type LocalEnvName = Extract<EnvName, "development" | "preview">;

/** One `KEY=value` line a pull writes. */
export interface EnvLocalValue {
  key: string;
  value: string;
}

export interface LocalEnvValue extends EnvLocalValue {
  /** Whether the registry marks the value a credential. */
  secret: boolean;
  source: "registry" | "parameter-store";
}

export interface ResolveLocalEnvInput {
  env: LocalEnvName;
  /** Every parameter under `prefix`, full paths. */
  parameters: readonly Parameter[];
  /** The environment's prefix, such as `/oxagen/development`. */
  prefix: string;
  /** Every parameter under `/oxagen/operator`, when the caller read it. */
  operatorParameters?: readonly Parameter[];
}

export interface LocalEnvResult {
  /** The environment's values, in registry order. Every target gets these. */
  values: LocalEnvValue[];
  /** Operator values, in registry order. Only the root target gets these. */
  operatorValues: LocalEnvValue[];
  /** Required in this environment, with no static value and no parameter. */
  missingRequired: string[];
  /**
   * Static keys whose parameter holds a different value. The file uses the
   * registry's, as a build does, and the parameter misleads whoever reads it.
   */
  drift: string[];
  /**
   * Full names of parameters that match no registry key, or whose key the
   * registry keeps in another store, such as a `ci` key under
   * `/oxagen/development`.
   */
  unknown: string[];
}

/** The stores whose keys may sit under an environment's prefix. */
const ENVIRONMENT_PREFIX_STORES: ReadonlySet<ValueStore> = new Set<ValueStore>([
  "environment",
  // A static key belongs in the registry, but a parameter that repeats it
  // with the same value does no harm, and a different value is drift.
  "registry",
]);

/** The stores whose keys may sit under `/oxagen/operator`. */
const OPERATOR_PREFIX_STORES: ReadonlySet<ValueStore> = new Set<ValueStore>([
  "operator",
]);

function valuesByLeaf(
  parameters: readonly Parameter[],
  prefix: string,
): Map<string, string> {
  const byLeaf = new Map<string, string>();
  for (const { Name, Value } of parameters) {
    const leaf = leafName(prefix, Name);
    if (leaf !== undefined) byLeaf.set(leaf, Value);
  }
  return byLeaf;
}

function misplaced(
  parameters: readonly Parameter[],
  prefix: string,
  belongs: ReadonlySet<ValueStore>,
): string[] {
  const names: string[] = [];
  for (const { Name } of parameters) {
    const leaf = leafName(prefix, Name);
    if (leaf === undefined) continue;
    const store = storeOf(leaf);
    if (store === undefined || !belongs.has(store)) names.push(Name);
  }
  return names;
}

/**
 * Resolve every value a laptop's `.env.local` files get for `env`. Names only
 * in the three lists, never values.
 */
export function resolveLocalEnv({
  env,
  parameters,
  prefix,
  operatorParameters,
}: ResolveLocalEnvInput): LocalEnvResult {
  const fromStore = valuesByLeaf(parameters, prefix);
  const fromOperator = operatorParameters
    ? valuesByLeaf(operatorParameters, OPERATOR_PARAMETER_PREFIX)
    : new Map<string, string>();

  const values: LocalEnvValue[] = [];
  const operatorValues: LocalEnvValue[] = [];
  const missingRequired: string[] = [];
  const drift: string[] = [];

  for (const [key, meta] of Object.entries(ENV_REGISTRY)) {
    const store = storeOf(key);

    if (store === "operator") {
      const value = fromOperator.get(key);
      if (value !== undefined) {
        operatorValues.push({
          key,
          value,
          secret: meta.secret,
          source: "parameter-store",
        });
      }
      continue;
    }
    if (store !== "environment" && store !== "registry") continue;

    // build-env.ts order: a static value first, then the parameter. A static
    // key with no value for this environment (BETTER_AUTH_URL in preview)
    // falls through to its parameter, as it does in a build.
    const staticValue =
      meta.valueOrigin === "static" ? staticValueFor(key, env) : undefined;
    const stored = fromStore.get(key);

    if (staticValue !== undefined) {
      values.push({
        key,
        value: staticValue,
        secret: meta.secret,
        source: "registry",
      });
      if (stored !== undefined && stored !== staticValue) drift.push(key);
      continue;
    }
    if (stored !== undefined) {
      values.push({
        key,
        value: stored,
        secret: meta.secret,
        source: "parameter-store",
      });
      continue;
    }
    if (meta.requiredIn.includes(env)) missingRequired.push(key);
  }

  const unknown = [
    ...misplaced(parameters, prefix, ENVIRONMENT_PREFIX_STORES),
    ...(operatorParameters
      ? misplaced(
          operatorParameters,
          OPERATOR_PARAMETER_PREFIX,
          OPERATOR_PREFIX_STORES,
        )
      : []),
  ];

  return { values, operatorValues, missingRequired, drift, unknown };
}

/** Characters a value can carry with no quotes in any dotenv parser. */
const BARE_VALUE = /^[A-Za-z0-9_@%+=:,./-]*$/;

/**
 * Write one value so that Node's `--env-file` parser (`parseEnv`) and the
 * dotenv parser Next.js loads both read it back unchanged:
 *
 *   - bare, when every character is safe unquoted;
 *   - in single quotes, which neither parser looks inside, when the value has
 *     no `'` and no line break;
 *   - in double quotes, with each line break written as the two characters
 *     `\n`, which both parsers turn back into a line break. This needs a value
 *     with no `"`, and with no backslash before an `n` or `r` of its own,
 *     which a parser would read as an escape.
 *
 * A carriage return fits none of these, because Node drops every one in the
 * file before it parses. Anything left throws, naming the key and not the
 * value.
 *
 * Next.js also expands `$NAME` inside a value, in any quotes, and Node does
 * not. No format here changes that, so a value with a `$` reads back
 * differently in apps/app. Vercel's pull wrote the same files.
 */
export function formatDotenvValue(key: string, value: string): string {
  if (BARE_VALUE.test(value)) return value;
  const hasReturn = value.includes("\r");
  if (!value.includes("'") && !value.includes("\n") && !hasReturn) {
    return `'${value}'`;
  }
  if (!value.includes('"') && !hasReturn && !/\\[nr]/.test(value)) {
    return `"${value.replaceAll("\n", "\\n")}"`;
  }
  throw new Error(
    `${key} has a value .env.local cannot hold: it mixes quote marks, line ` +
      `breaks, carriage returns, or backslash escapes that no dotenv quoting ` +
      `reads back unchanged. Change the stored value, or set ${key} in your ` +
      `shell instead.`,
  );
}

/** The line that splits a generated `.env.local` from the developer's part. */
export const LOCAL_OVERRIDES_MARKER =
  "# --- local overrides: env:pull keeps everything below this line ---";

const CARRIED_COMMENT =
  "# Carried over from the .env.local this pull replaced, which is saved as " +
  ".env.local.bak. Delete what you no longer need.";

function header(source: string): string[] {
  return [
    `# Written by \`pnpm env:pull\` from ${source} (ADR-240).`,
    "# The next pull rewrites everything above the marker line.",
    "# Put local changes below the marker. They win, and every pull keeps them.",
  ];
}

export interface RenderEnvLocalInput {
  /** Where the values came from, for the header: a prefix or two. */
  source: string;
  values: readonly EnvLocalValue[];
  /** Everything below the marker, kept as it is. */
  overrides: string;
}

/**
 * The whole file: the header, a line for each value the override block does
 * not set, the marker, then the override block. Deterministic, with no
 * timestamp, so a pull that changes nothing writes the same bytes.
 */
export function renderEnvLocal({
  source,
  values,
  overrides,
}: RenderEnvLocalInput): string {
  const overridden = new Set(Object.keys(parseEnv(overrides)));
  const lines = values
    .filter(({ key }) => !overridden.has(key))
    .map(({ key, value }) => `${key}=${formatDotenvValue(key, value)}`);

  const parts = [...header(source), ""];
  if (lines.length > 0) parts.push(...lines, "");
  parts.push(LOCAL_OVERRIDES_MARKER);

  const block =
    overrides === "" || overrides.endsWith("\n") ? overrides : `${overrides}\n`;
  return `${parts.join("\n")}\n${block}`;
}

export interface SplitEnvLocal {
  /** Everything above the marker line. */
  generated: string;
  /** Everything below the marker line, or undefined when there is no marker. */
  overrides: string | undefined;
}

/** Split a file at its first marker line. */
export function splitEnvLocal(text: string): SplitEnvLocal {
  const lines = text.split("\n");
  const index = lines.findIndex(
    (line) => line.trimEnd() === LOCAL_OVERRIDES_MARKER,
  );
  if (index === -1) return { generated: text, overrides: undefined };
  return {
    generated: lines.slice(0, index).join("\n"),
    overrides: lines.slice(index + 1).join("\n"),
  };
}

export interface PlanEnvLocalInput {
  /** The file as it is now, or undefined when there is none. */
  existing: string | undefined;
  source: string;
  values: readonly EnvLocalValue[];
}

export interface EnvLocalPlan {
  /** The file to write. */
  text: string;
  /** Keys moved below the marker from a file that had no marker. */
  carried: string[];
  /** Pulled keys that a line below the marker sets, so the pulled value is unused. */
  overridden: string[];
  /** Copy the existing file to `.env.local.bak` before writing. */
  backup: boolean;
}

function plan(
  source: string,
  values: readonly EnvLocalValue[],
  overrides: string,
  carried: string[],
  backup: boolean,
): EnvLocalPlan {
  const set = new Set(Object.keys(parseEnv(overrides)));
  return {
    text: renderEnvLocal({ source, values, overrides }),
    carried,
    overridden: values.map(({ key }) => key).filter((key) => set.has(key)),
    backup,
  };
}

/**
 * Decide what one `.env.local` becomes.
 *
 * A file with a marker keeps its override block. A file without one predates
 * this script, usually Vercel's pull: every key in it that the pull does not
 * supply moves below the marker, so nothing set by hand is lost, and the
 * caller keeps the old file as `.env.local.bak`.
 */
export function planEnvLocal({
  existing,
  source,
  values,
}: PlanEnvLocalInput): EnvLocalPlan {
  if (existing === undefined) return plan(source, values, "", [], false);

  const { overrides } = splitEnvLocal(existing);
  if (overrides !== undefined) {
    return plan(source, values, overrides, [], false);
  }

  const pulled = new Set(values.map(({ key }) => key));
  const previous = parseEnv(existing);
  const carried = Object.keys(previous)
    .filter((key) => !pulled.has(key))
    .sort();
  const block =
    carried.length === 0
      ? ""
      : `${[
          CARRIED_COMMENT,
          ...carried.map(
            (key) => `${key}=${formatDotenvValue(key, previous[key] ?? "")}`,
          ),
        ].join("\n")}\n`;

  return plan(source, values, block, carried, true);
}

export interface EnvLocalDiff {
  added: string[];
  changed: string[];
  removed: string[];
}

/**
 * What a pull would change, as key names: the values each file sets, parsed
 * the way Node parses them, before and after. Comments and order do not count.
 */
export function diffEnvLocal(
  existing: string | undefined,
  next: string,
): EnvLocalDiff {
  const before = parseEnv(existing ?? "");
  const after = parseEnv(next);
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];

  for (const key of Object.keys(after).sort()) {
    if (!Object.hasOwn(before, key)) added.push(key);
    else if (before[key] !== after[key]) changed.push(key);
  }
  for (const key of Object.keys(before).sort()) {
    if (!Object.hasOwn(after, key)) removed.push(key);
  }
  return { added, changed, removed };
}
