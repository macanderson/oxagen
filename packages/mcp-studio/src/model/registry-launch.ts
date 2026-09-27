// registry-launch.ts: the command and args that run a registry entry's
// package on the local gateway (mcp-studio-spec, Registry packages).
//
// lock() writes the launch into tools.lock.json, and the compile check
// reports its problems. This mapping is part of the model, so the lock,
// compile, and the fixtures agree on it.
import type { RegistryLockPackage } from "../contract/lock";
import type { RegistryArgument, RegistryEntry, RegistryPackage } from "../contract/registry-entry";
import type { RegistryType, ServerSource } from "../contract/server";

/** How the local gateway runs one package type. */
export interface RegistryRunner {
  command: string;
  /** The flags before the entry's runtimeArguments. oci adds -e NAME for each name in source.env. */
  flags: readonly string[];
  /** What the package reference pins after the @: the version, or the image's digest. */
  pin: "version" | "digest";
}

/** The spec's launch table: one runner per package type. */
export const REGISTRY_RUNNERS: Readonly<Record<RegistryType, RegistryRunner>> = {
  npm: { command: "npx", flags: ["--yes"], pin: "version" },
  pypi: { command: "uvx", flags: [], pin: "version" },
  oci: { command: "docker", flags: ["run", "--rm", "-i"], pin: "digest" },
  nuget: { command: "dnx", flags: ["--yes"], pin: "version" },
};

export type RegistrySource = Extract<ServerSource, { type: "registry" }>;

export interface RegistryLaunchInput {
  /** server.toml's source, parsed. */
  source: RegistrySource;
  /** The catalog entry at source.version. */
  entry: RegistryEntry;
  /** The package's digest: for oci the image's manifest digest, for the others the archive's SHA-256. */
  digest: string;
}

/** One reason the package cannot run, on the server.toml field a person changes to fix it. */
export interface LaunchProblem {
  /** source.registry_type, source.env, or source.arguments.<key>. */
  field: string;
  message: string;
}

export type RegistryLaunch =
  | { ok: true; command: string; args: string[]; package: RegistryLockPackage }
  | { ok: false; problems: LaunchProblem[] };

/** A secret's whole value is one variable, so no secret enters the repository. */
const ONE_VARIABLE = /^\$\{[A-Za-z_][A-Za-z0-9_]{0,127}\}$/;

/** Entry text in an argument, with each $ written $$ so the local gateway fills nothing in it. */
function literal(text: string): string {
  return text.split("$").join("$$");
}

interface Slot {
  argument: RegistryArgument;
  /** runtimeArguments[0] or packageArguments[2], for messages. */
  label: string;
  /** A named argument's name, or a positional argument's valueHint. */
  name: string | undefined;
  /** The source.arguments key: the name, or undefined when the entry fixes the value. */
  key: string | undefined;
}

function slots(pkg: RegistryPackage): { runtime: Slot[]; packaged: Slot[] } {
  const slot =
    (list: string) =>
    (argument: RegistryArgument, index: number): Slot => {
      const name = argument.type === "named" ? argument.name : argument.valueHint;
      return { argument, label: `${list}[${index}]`, name, key: argument.value === undefined ? name : undefined };
    };
  return {
    runtime: (pkg.runtimeArguments ?? []).map(slot("runtimeArguments")),
    packaged: (pkg.packageArguments ?? []).map(slot("packageArguments")),
  };
}

/**
 * Problems with the keys source.arguments sets arguments by: missing, shared,
 * or unknown. A fixed argument counts toward a shared key. An entry with a
 * fixed --port and a settable --port passes both flags, and the package picks
 * one by its own rule. Arguments that are all fixed may share a name, since
 * source.arguments sets none of them.
 */
function keyProblems(all: readonly Slot[], given: Readonly<Record<string, string>>, type: RegistryType): LaunchProblem[] {
  const problems: LaunchProblem[] = [];
  const counts = new Map<string, number>();
  const settable = new Set<string>();
  for (const { argument, label, name, key } of all) {
    if (argument.value === undefined && name === undefined) {
      problems.push({
        field: "source.registry_type",
        message: `the ${type} package's positional argument ${label} has no valueHint, so source.arguments cannot set it`,
      });
    }
    if (name !== undefined) counts.set(name, (counts.get(name) ?? 0) + 1);
    if (key !== undefined) settable.add(key);
  }
  for (const [name, count] of counts) {
    if (count > 1 && settable.has(name)) {
      problems.push({
        field: `source.arguments.${name}`,
        message: `the ${type} package has ${count} arguments keyed ${name}, so source.arguments cannot tell them apart`,
      });
    }
  }
  for (const key of Object.keys(given)) {
    if (settable.has(key)) continue;
    problems.push({
      field: `source.arguments.${key}`,
      message: counts.has(key)
        ? `the ${type} package fixes ${key}, so source.arguments cannot set it`
        : `the ${type} package takes no argument keyed ${key}`,
    });
  }
  return problems;
}

/** One argument's words: its value alone, or its name then its value. None when it has no value. */
function words(slot: Slot, given: Readonly<Record<string, string>>, problems: LaunchProblem[]): string[] {
  const { argument, label, key } = slot;
  const field = key === undefined ? "source.registry_type" : `source.arguments.${key}`;
  const set = key === undefined ? undefined : given[key];
  let value: string | undefined;
  if (set !== undefined) {
    if (argument.isSecret === true && !ONE_VARIABLE.test(set)) {
      problems.push({ field, message: `${key} is secret, so its value is one \${NAME} from source.env` });
    }
    value = set;
  } else {
    const fromEntry = argument.value ?? argument.default;
    // The lock is committed, so a secret never takes its value from the entry.
    if (fromEntry !== undefined && argument.isSecret === true) {
      problems.push({
        field,
        message:
          key === undefined
            ? `${label} is secret, and the entry fixes its value, so the lock would hold the secret in plain text`
            : `${label} is secret, so the entry's default cannot fill it. Set ${key} in source.arguments to one \${NAME} from source.env.`,
      });
      return [];
    }
    if (fromEntry !== undefined && Object.keys(argument.variables ?? {}).length > 0) {
      problems.push({
        field,
        message:
          key === undefined
            ? `${label} fills registry variables into its fixed value, and the local gateway fills none`
            : `${label} fills registry variables into its default, and the local gateway fills none. Set ${key} in source.arguments.`,
      });
    }
    value = fromEntry === undefined ? undefined : literal(fromEntry);
  }
  if (value === undefined) {
    if (argument.isRequired === true) {
      problems.push({ field, message: `${label} is required, and neither source.arguments nor the entry gives it a value` });
    }
    return [];
  }
  return argument.type === "named" ? [literal(argument.name), value] : [value];
}

/**
 * The command and args for source.registry_type's package, in the spec's
 * order: the type's fixed flags, the entry's runtimeArguments, the package
 * reference, then the package arguments in the entry's order. `${NAME}` stays
 * in args for the local gateway to fill from the machine. Returns every
 * problem found, not only the first.
 */
export function registryLaunch({ source, entry, digest }: RegistryLaunchInput): RegistryLaunch {
  const type = source.registry_type;
  if (type === undefined) {
    return {
      ok: false,
      problems: [{ field: "source.registry_type", message: "source.registry_type picks the package the local gateway runs" }],
    };
  }
  const matches = (entry.server.packages ?? []).filter((candidate) => candidate.registryType === type);
  const [pkg] = matches;
  if (pkg === undefined || matches.length > 1) {
    return {
      ok: false,
      problems: [
        {
          field: "source.registry_type",
          message:
            pkg === undefined
              ? `the entry lists no ${type} package`
              : `the entry lists ${matches.length} ${type} packages, so source.registry_type cannot pick one`,
        },
      ],
    };
  }

  const runner = REGISTRY_RUNNERS[type];
  const problems: LaunchProblem[] = [];
  if (pkg.transport.type !== "stdio") {
    problems.push({
      field: "source.registry_type",
      message: `the ${type} package serves ${pkg.transport.type}, and the local gateway runs only stdio packages`,
    });
  }
  if (pkg.runtimeHint !== undefined && pkg.runtimeHint !== runner.command) {
    problems.push({
      field: "source.registry_type",
      message: `the ${type} package runs with ${pkg.runtimeHint}, and the local gateway runs ${type} packages with ${runner.command}`,
    });
  }
  const env = source.env ?? [];
  for (const variable of pkg.environmentVariables ?? []) {
    if (variable.isRequired === true && !env.includes(variable.name)) {
      problems.push({ field: "source.env", message: `the ${type} package requires ${variable.name}, so source.env lists it` });
    }
  }

  const given = source.arguments ?? {};
  const { runtime, packaged } = slots(pkg);
  problems.push(...keyProblems([...runtime, ...packaged], given, type));

  const version = pkg.version ?? entry.server.version;
  const pin = runner.pin === "digest" ? digest : literal(version);
  const args = [
    ...runner.flags,
    ...(type === "oci" ? env.flatMap((name) => ["-e", name]) : []),
    ...runtime.flatMap((slot) => words(slot, given, problems)),
    `${literal(pkg.identifier)}@${pin}`,
    ...packaged.flatMap((slot) => words(slot, given, problems)),
  ];
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    command: runner.command,
    args,
    package: { name: pkg.identifier, version, digest, registry_type: type },
  };
}
