#!/usr/bin/env tsx
/**
 * build-env.ts — resolve a service's build-time environment from the canonical
 * registry plus a Parameter Store snapshot.
 *
 * `next build` collects page data by importing route modules, and several of
 * them validate the environment at import time; `NEXT_PUBLIC_*` values are
 * inlined into the client bundle. Both make production configuration a *build*
 * input, so the node cannot supply it when the container starts.
 *
 * The set of variables is derived from `ENV_REGISTRY` — the same authority
 * behind `.env.example`, the env-manager catalog and `env-check` — rather than
 * restated as a list of names in a workflow, which is how three hostnames came
 * to stand in for the whole environment (#1190).
 *
 * Values come from two places, in this order:
 *   1. the registry itself, for `valueOrigin: "static"` entries (public URLs);
 *   2. the Parameter Store snapshot on stdin or `--params`.
 *
 * A variable the registry marks `requiredIn` this environment and that neither
 * source supplies is a hard failure. One that is optional is reported as a
 * GitHub warning: the feature it drives degrades, and #1182 is the record of
 * how invisible that is when nothing says so.
 *
 * Usage:
 *   aws ssm get-parameters-by-path --path /oxagen/production --recursive \
 *     --with-decryption --output json \
 *     --query 'Parameters[].{Name:Name,Value:Value}' \
 *   | tsx tools/scripts/build-env.ts --service app --env production \
 *       --prefix /oxagen/production --out "$RUNNER_TEMP/build-env"
 */

import { readFileSync, writeFileSync } from "node:fs";
import { argv, exit, stdin, stdout } from "node:process";
import {
  ENV_NAMES,
  ENV_REGISTRY,
  SERVICE_NAMES,
  staticValueFor,
} from "@oxagen/config";
import type { EnvName, ServiceName } from "@oxagen/config";

/** One parameter as `aws ssm get-parameters-by-path` reports it. */
export interface Parameter {
  Name: string;
  Value: string;
}

export interface ResolveInput {
  service: ServiceName;
  env: EnvName;
  /** Parameter Store entries, full paths. */
  parameters: Parameter[];
  /** Path prefix to strip from each parameter name. */
  prefix: string;
}

export interface ResolvedVar {
  key: string;
  value: string;
  /** Whether the registry marks this value as encrypted at rest. */
  secret: boolean;
  source: "registry" | "parameter-store";
}

export interface ResolveResult {
  resolved: ResolvedVar[];
  /** Required by the registry for this service+env, and supplied by nothing. */
  missingRequired: string[];
  /**
   * Optional, and inlined into the client bundle. Absent at build time means
   * absent for the life of the artifact — the node cannot supply it later — so
   * the feature it drives is off until someone rebuilds. This is the class
   * #1182 is about, and the reason it warns.
   */
  missingInlined: string[];
  /**
   * Optional and server-side. The node reads Parameter Store at container
   * start, so a value that appears there later takes effect without a rebuild;
   * its absence at build time is not a defect and is not reported.
   */
  missingOptional: string[];
}

/**
 * Resolve every variable this service needs in this environment.
 *
 * Pure: takes the Parameter Store snapshot as data so the decision can be
 * tested without AWS.
 */
export function resolveBuildEnv({
  service,
  env,
  parameters,
  prefix,
}: ResolveInput): ResolveResult {
  const normalizedPrefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const fromStore = new Map<string, string>();
  for (const { Name, Value } of parameters) {
    const leaf = Name.startsWith(`${normalizedPrefix}/`)
      ? Name.slice(normalizedPrefix.length + 1)
      : Name;
    // A nested path (`/oxagen/production/neo4j/password`) is not a shell
    // variable name and never was one; the registry only ever names leaves.
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(leaf)) fromStore.set(leaf, Value);
  }

  const resolved: ResolvedVar[] = [];
  const missingRequired: string[] = [];
  const missingInlined: string[] = [];
  const missingOptional: string[] = [];

  for (const [key, meta] of Object.entries(ENV_REGISTRY)) {
    if (!meta.services.includes(service)) continue;

    const staticValue =
      meta.valueOrigin === "static" ? staticValueFor(key, env) : undefined;
    const value = staticValue ?? fromStore.get(key);

    if (value === undefined) {
      if (meta.requiredIn.includes(env)) missingRequired.push(key);
      else if (meta.clientExposed) missingInlined.push(key);
      else missingOptional.push(key);
      continue;
    }

    resolved.push({
      key,
      value,
      secret: meta.secret,
      source: staticValue === undefined ? "parameter-store" : "registry",
    });
  }

  return { resolved, missingRequired, missingInlined, missingOptional };
}

/** Quote a value so a POSIX shell reads it back byte-for-byte. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Render the resolved set as a file `set -a; . file` can source. */
export function renderEnvFile(resolved: readonly ResolvedVar[]): string {
  const lines = resolved.map(({ key, value }) => `${key}=${shellQuote(value)}`);
  return `${lines.join("\n")}\n`;
}

function flag(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const service = flag("service");
  const env = flag("env") ?? "production";
  const prefix = flag("prefix") ?? `/oxagen/${env}`;
  const out = flag("out");
  const paramsFile = flag("params");

  if (!service || !SERVICE_NAMES.includes(service as ServiceName)) {
    stdout.write(
      `build-env: --service must be one of ${SERVICE_NAMES.join(", ")}\n`,
    );
    exit(2);
  }
  if (!ENV_NAMES.includes(env as EnvName)) {
    stdout.write(`build-env: --env must be one of ${ENV_NAMES.join(", ")}\n`);
    exit(2);
  }

  const raw = paramsFile ? readFileSync(paramsFile, "utf8") : await readStdin();
  const parameters = (raw.trim() === "" ? [] : JSON.parse(raw)) as Parameter[];

  const { resolved, missingRequired, missingInlined, missingOptional } =
    resolveBuildEnv({
      service: service as ServiceName,
      env: env as EnvName,
      parameters,
      prefix,
    });

  // Mask before anything else can echo one. A multi-line secret has to be
  // masked line by line — the workflow-command parser reads one line at a time.
  for (const { value, secret } of resolved) {
    if (!secret) continue;
    for (const line of value.split("\n")) {
      if (line.length > 0) stdout.write(`::add-mask::${line}\n`);
    }
  }

  for (const key of missingInlined) {
    stdout.write(
      `::warning title=Missing client value::${key} is compiled into the ` +
        `${service} bundle and ${prefix} has no value for it, so the feature ` +
        `it drives stays off until someone sets it and rebuilds.\n`,
    );
  }

  if (missingRequired.length > 0) {
    stdout.write(
      `::error title=Incomplete build environment::${service} requires ` +
        `${missingRequired.join(", ")} in ${env}; ${prefix} supplies neither ` +
        `these nor a registry default. Set them in Parameter Store.\n`,
    );
    exit(1);
  }

  const file = renderEnvFile(resolved);
  if (out) writeFileSync(out, file, { mode: 0o600 });
  else stdout.write(file);

  stdout.write(
    `build-env: ${service}/${env} resolved ${resolved.length} variables; ` +
      `${missingInlined.length} client values missing, ` +
      `${missingOptional.length} server-side optional left to the node\n`,
  );
}

// `import.meta.url` is the entry point only when run directly, not when a test
// imports the pure helpers above.
if (import.meta.url === `file://${argv[1]}`) {
  await main();
}
