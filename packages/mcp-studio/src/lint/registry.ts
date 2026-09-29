// registry.ts: the checks on a registry source: where the server runs, and
// whether the local gateway can start the entry's package.
//
// The package checks read the same slots as registryLaunch in
// src/model/registry-launch.ts, which writes the launch into the lock. A test
// in registry.test.ts holds the two together: lint reports a registry error
// exactly when registryLaunch refuses the package.
import type { RegistryArgument, RegistryEntry, RegistryPackage } from "../contract/registry-entry";
import { REGISTRY_TYPES, templateVariables, type RegistryType } from "../contract/server";
import { REGISTRY_RUNNERS, registryLaunch, type RegistrySource } from "../model/registry-launch";
import type { ServerFolder } from "./index";
import { orList, type Report } from "./report";

/** A secret's whole value is one variable, so no secret enters the repository. registryLaunch holds the same pattern. */
const ONE_VARIABLE = /^\$\{[A-Za-z_][A-Za-z0-9_]{0,127}\}$/;

/**
 * The one remote type the cloud gateway calls. registryLockSource in
 * src/lock/index.ts pins a streamable-http remote and skips sse (ADR-211).
 */
const CALLED_REMOTE = "streamable-http";

/** Whether the entry lists a remote the cloud gateway can call. */
function callableRemote(entry: RegistryEntry): boolean {
  return (entry.server.remotes ?? []).some((remote) => remote.type === CALLED_REMOTE);
}

/**
 * Whether the local gateway could start the entry's package of this type once
 * server.toml picks it. registryLaunch refuses on source.registry_type only
 * for faults in the package itself: none or several of the type, a transport
 * other than stdio, another runner, an argument no source.arguments key can
 * set, or two settable arguments that share a key. Faults on source.env and
 * source.arguments are the operator's to fix.
 */
function packageRuns(source: RegistrySource, entry: RegistryEntry, type: RegistryType): boolean {
  const launch = registryLaunch({ source: { ...source, registry_type: type }, entry, digest: "" });
  return launch.ok || launch.problems.every((problem) => problem.field !== "source.registry_type");
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

function slotsOf(pkg: RegistryPackage): Slot[] {
  const slot =
    (list: string) =>
    (argument: RegistryArgument, index: number): Slot => {
      const name = argument.type === "named" ? argument.name : argument.valueHint;
      return { argument, label: `${list}[${index}]`, name, key: argument.value === undefined ? name : undefined };
    };
  return [
    ...(pkg.runtimeArguments ?? []).map(slot("runtimeArguments")),
    ...(pkg.packageArguments ?? []).map(slot("packageArguments")),
  ];
}

/**
 * The fix when the chosen package cannot run: another package type that runs,
 * a remote the cloud gateway calls, or another version.
 */
function otherChoice(source: RegistrySource, entry: RegistryEntry, current: RegistryType | undefined): string {
  const runnable = REGISTRY_TYPES.filter((type) => type !== current && packageRuns(source, entry, type));
  if (runnable.length > 0) {
    return `Set source.registry_type to ${orList(runnable.map((type) => JSON.stringify(type)))} in server.toml.`;
  }
  if (callableRemote(entry)) {
    return "Remove source.machines, registry_type, env, and arguments from server.toml and add auth, so the cloud gateway connects to the entry's remote.";
  }
  return "Set source.version to a catalog version whose entry lists one npm, pypi, oci, or nuget package that serves stdio.";
}

export function lintRegistry(folder: ServerFolder, report: Report): void {
  const { source } = folder.server;
  if (source.type !== "registry") return;
  const entry = folder.registry_entry;

  if (source.machines === undefined) {
    if (entry !== undefined && !callableRemote(entry)) {
      const listed = (entry.server.remotes ?? []).length > 0;
      report("registry_without_remote", {
        tool: undefined,
        field: "source.machines",
        message: listed
          ? `The catalog entry for ${source.server} ${source.version} lists no streamable-http remote, and source.machines names no machine group, so the server runs nowhere. The cloud gateway calls only streamable-http remotes.`
          : `The catalog entry for ${source.server} ${source.version} lists no remote, and source.machines names no machine group, so the server runs nowhere.`,
        fix: "Set source.machines to the machine groups whose local gateway runs the package, and source.registry_type to its type. Remove auth and environments, which that server does not take.",
      });
    }
    return;
  }
  if (source.machines.length === 0) {
    report("registry_without_remote", {
      tool: undefined,
      field: "source.machines",
      message: "source.machines names no machine group, so the package runs nowhere.",
      fix: "Add the machine groups whose local gateway runs the package to source.machines in server.toml.",
    });
  }

  const env = source.env ?? [];
  for (const [key, value] of Object.entries(source.arguments ?? {})) {
    for (const name of templateVariables(value)) {
      if (env.includes(name)) continue;
      report("env_variable_missing", {
        tool: undefined,
        field: `source.arguments.${key}`,
        message: `source.arguments.${key} uses \${${name}}, and source.env does not list ${name}, so the local gateway would not pass it.`,
        fix: `Add "${name}" to source.env in server.toml.`,
      });
    }
  }

  const type = source.registry_type;
  if (type === undefined) {
    report("package_cannot_run", {
      tool: undefined,
      field: "source.registry_type",
      message: "source.registry_type is not set, so the local gateway has no package to run.",
      fix:
        entry === undefined
          ? "Set source.registry_type to the type of the entry's package: npm, pypi, oci, or nuget."
          : otherChoice(source, entry, undefined),
    });
    return;
  }
  if (entry === undefined) return;
  lintPackage(source, entry, type, report);
}

/** The checks registryLaunch makes on the package source.registry_type picks. */
function lintPackage(source: RegistrySource, entry: RegistryEntry, type: RegistryType, report: Report): void {
  const other = otherChoice(source, entry, type);
  const packages = entry.server.packages ?? [];
  const matches = packages.filter((candidate) => candidate.registryType === type);
  const [pkg] = matches;
  if (pkg === undefined || matches.length > 1) {
    const bundle = packages.some((candidate) => candidate.registryType === "mcpb");
    report("package_cannot_run", {
      tool: undefined,
      field: "source.registry_type",
      message:
        pkg === undefined
          ? `The catalog entry lists no ${type} package${bundle ? ", and the local gateway cannot run its mcpb bundle" : ""}, so nothing could start the server.`
          : `The catalog entry lists ${matches.length} ${type} packages, so source.registry_type cannot pick one.`,
      fix: other,
    });
    return;
  }

  const runner = REGISTRY_RUNNERS[type];
  if (pkg.transport.type !== "stdio") {
    report("package_cannot_run", {
      tool: undefined,
      field: "source.registry_type",
      message: `The ${type} package serves ${pkg.transport.type}, and the local gateway runs only stdio packages.`,
      fix: other,
    });
  }
  if (pkg.runtimeHint !== undefined && pkg.runtimeHint !== runner.command) {
    report("package_cannot_run", {
      tool: undefined,
      field: "source.registry_type",
      message: `The ${type} package expects ${pkg.runtimeHint}, and the local gateway runs ${type} packages with ${runner.command}.`,
      fix: other,
    });
  }
  const env = source.env ?? [];
  for (const variable of pkg.environmentVariables ?? []) {
    if (variable.isRequired !== true || env.includes(variable.name)) continue;
    report("env_variable_missing", {
      tool: undefined,
      field: "source.env",
      message: `The ${type} package requires ${variable.name}, and source.env does not list it, so the local gateway would not pass it.`,
      fix: `Add "${variable.name}" to source.env in server.toml.`,
    });
  }

  const given = source.arguments ?? {};
  const slots = slotsOf(pkg);
  lintKeys(slots, given, type, other, report);
  for (const slot of slots) lintSlot(slot, given, other, report);
}

/** Keys source.arguments sets arguments by: missing, shared, or unknown. */
function lintKeys(
  slots: readonly Slot[],
  given: Readonly<Record<string, string>>,
  type: RegistryType,
  other: string,
  report: Report,
): void {
  const counts = new Map<string, number>();
  const settable = new Set<string>();
  for (const { argument, label, name, key } of slots) {
    if (argument.value === undefined && name === undefined) {
      report("argument_without_value", {
        tool: undefined,
        field: "source.registry_type",
        message: `The ${type} package's positional argument ${label} has no valueHint, so source.arguments cannot set it.`,
        fix: other,
      });
    }
    if (name !== undefined) counts.set(name, (counts.get(name) ?? 0) + 1);
    if (key !== undefined) settable.add(key);
  }
  for (const [name, count] of counts) {
    if (count < 2 || !settable.has(name)) continue;
    report("argument_without_value", {
      tool: undefined,
      field: "source.registry_type",
      message: `The ${type} package has ${count} arguments keyed ${name}, so source.arguments cannot tell them apart.`,
      fix: other,
    });
  }
  const keys = [...settable];
  for (const key of Object.keys(given)) {
    if (settable.has(key)) continue;
    const fixed = counts.has(key);
    report("argument_without_value", {
      tool: undefined,
      field: `source.arguments.${key}`,
      message: fixed
        ? `The ${type} package fixes ${key}, so source.arguments cannot set it.`
        : `The ${type} package takes no argument keyed ${key}.`,
      fix:
        fixed || keys.length === 0
          ? `Remove ${key} from source.arguments.`
          : `Remove ${key} from source.arguments, or rename it to ${orList(keys)}.`,
    });
  }
}

/** One argument's value: set in source.arguments, fixed or defaulted by the entry, or missing. */
function lintSlot(slot: Slot, given: Readonly<Record<string, string>>, other: string, report: Report): void {
  const { argument, label, key } = slot;
  const field = key === undefined ? "source.registry_type" : `source.arguments.${key}`;
  const set = key === undefined ? undefined : given[key];
  if (set !== undefined) {
    if (argument.isSecret === true && !ONE_VARIABLE.test(set)) {
      report("secret_literal", {
        tool: undefined,
        field,
        message: `${key} is a secret argument, and source.arguments sets it to a literal, so the secret would enter the repository.`,
        fix: `Set ${key} to one \${NAME} and add NAME to source.env, so the local gateway reads the secret from the machine.`,
      });
    }
    return;
  }
  const fromEntry = argument.value ?? argument.default;
  if (fromEntry !== undefined && argument.isSecret === true) {
    report("secret_literal", {
      tool: undefined,
      field,
      message:
        key === undefined
          ? `${label} is a secret argument, and the entry fixes its value, so the lock would hold the secret in plain text.`
          : `${label} is a secret argument, and only the entry's default fills it, so the lock would hold the secret in plain text.`,
      fix:
        key === undefined
          ? other
          : `Set ${key} in source.arguments to one \${NAME} and add NAME to source.env, so the local gateway reads the secret from the machine.`,
    });
    return;
  }
  if (fromEntry !== undefined && Object.keys(argument.variables ?? {}).length > 0) {
    if (key === undefined) {
      report("package_cannot_run", {
        tool: undefined,
        field,
        message: `${label} fills registry variables into its fixed value, and the local gateway fills none.`,
        fix: other,
      });
    } else {
      report("argument_without_value", {
        tool: undefined,
        field,
        message: `${label} fills registry variables into its default, and the local gateway fills none.`,
        fix: `Set ${key} in source.arguments.`,
      });
    }
  }
  if (fromEntry === undefined && argument.isRequired === true) {
    report("argument_without_value", {
      tool: undefined,
      field,
      message: `${label} is required, and neither source.arguments nor the entry gives it a value.`,
      fix: key === undefined ? other : `Set ${key} in source.arguments.`,
    });
  }
}
