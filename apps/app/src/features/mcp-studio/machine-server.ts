// Add server's Local command and registry package forms (#4678, items 2 and
// 3; ADR-233, #4756): the server.toml Studio writes for a new server that
// runs on machines, checked before the save so the form names each problem
// in its own words.
//
// A server that runs on machines has no definition to upload. The dialog
// saves its server.toml alone, then asks a machine in source.machines to
// list its tools (start_studio_listing). The machine checks the pin before
// it starts anything:
//   - A local command's pin is the version and SHA-256 the person names.
//   - A registry package's pin is the SHA-256 Oxagen reads from the public
//     registry, so the form sends none. Oxagen pins npm and NuGet packages.
//     PyPI and OCI wait on #4756's last item, so the form does not offer them.
//
// What this path writes is narrow on purpose:
//   - No auth and no environments: the local gateway runs the server and
//     Oxagen sends it no credential (server.toml's localHasNoAuth).
//   - Exposure is direct. A local command syncs manually, because only a new
//     draft moves its pin. A registry package syncs daily, because Oxagen
//     reads each catalog version's digest itself (ADR-233, decision 4).
//   - A secret argument takes no value in the form. Studio writes `${NAME}`
//     and lists NAME in source.env, so the value stays on each machine.
//
// The module imports only types, so the client bundle carries no contract
// code. The rules mirror packages/mcp-studio/src/contract/server.ts, so a
// form that passes them should not come back server_toml_invalid.
import type { RegistryPackageArgument } from "@/data/contracts/tools";
import type { NewStudioServer } from "./review-calls";
import type { StudioListingPin } from "./studio-calls";

/** The official MCP registry, the one search_mcp_registry reads. */
const OFFICIAL_REGISTRY = "https://registry.modelcontextprotocol.io";

/** The package types Oxagen pins today: it reads their digest itself. */
export const PINNED_PACKAGE_TYPES = ["npm", "nuget"] as const;
export type PinnedPackageType = (typeof PINNED_PACKAGE_TYPES)[number];

/** A server name: the folder under tools/servers/ (steering-repo/names.ts). */
const SERVER_NAME_PATTERN = /^[a-z][a-z0-9_]{0,23}$/;
const BUILTIN_SERVER = "builtin";
const SERVER_NAME_MAX = 24;
const LABEL_MAX = 80;
const DESCRIPTION_MAX = 200;
const COMMAND_MAX = 1024;
const ARGUMENT_MAX = 4096;
const ARGUMENTS_MAX = 256;
const VERSION_MAX = 64;
const GROUPS_MAX = 64;
const VARIABLES_MAX = 128;
const MACHINE_GROUP = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** An argument value: `${NAME}` names a variable, and `$$` writes one `$`. */
const ARGUMENT_VALUE = /^(?:[^$]|\$\$|\$\{[A-Za-z_][A-Za-z0-9_]{0,127}\})*$/;
const TEMPLATE_TOKEN = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}/g;
/** 64 hex characters, with or without `sha256:`, as shasum -a 256 prints them. */
const DIGEST = /^(?:sha256:)?([0-9a-fA-F]{64})(?:\s+\S.*)?$/;

/** One thing the form must fix before the save. */
export type MachineProblem =
  | {
      kind:
        | "name"
        | "reserved"
        | "label"
        | "description"
        | "command"
        | "arguments"
        | "variables"
        | "machines"
        | "version"
        | "digest"
        | "entryVersion";
    }
  | { kind: "machine"; group: string }
  | { kind: "variable"; name: string }
  | { kind: "argumentRequired" | "argumentInvalid"; argument: string };

/** A new server that runs on machines, as the dialog saves and lists it. */
export type MachineServer = {
  server: NewStudioServer;
  /** A local command's pin. A registry package's pin is Oxagen's to read. */
  pin?: StudioListingPin;
};

type Built =
  | { ok: true; value: MachineServer }
  | { ok: false; problems: readonly MachineProblem[] };

/** A TOML basic string (new-server.ts has the reasoning). */
function tomlString(value: string): string {
  return JSON.stringify(value).replaceAll("\u007f", "\\u007F");
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

/** A textarea's lines, trimmed, with the blank ones dropped. */
function linesOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** The same lines, each kept once, in the order first written. */
function uniqueLines(text: string): string[] {
  return [...new Set(linesOf(text))];
}

/**
 * A SHA-256 as the pin takes it: `sha256:` and 64 lowercase hex characters.
 * Takes a bare digest, one with the prefix, or a shasum line with its file
 * name. Null when it is none of them.
 */
function normalizeDigest(raw: string): string | null {
  const match = DIGEST.exec(raw.trim());
  return match?.[1] === undefined ? null : `sha256:${match[1].toLowerCase()}`;
}

/** The variables an argument value names with `${NAME}`. */
function templateVariables(value: string): string[] {
  return [...value.matchAll(TEMPLATE_TOKEN)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/** The key source.arguments uses: a named argument's name, else its hint. */
export function argumentKey(argument: RegistryPackageArgument): string | null {
  const key = argument.name ?? argument.valueHint;
  return key === null || !/^\S{1,128}$/.test(key) ? null : key;
}

/**
 * The machine variable a secret argument reads: its key in upper snake
 * case. `--api-key` reads API_KEY.
 */
export function secretVariable(key: string): string {
  const name = key
    .replace(/^-+/, "")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()
    .slice(0, 128);
  if (name === "") return "SECRET";
  return /^[0-9]/.test(name) ? `_${name}`.slice(0, 128) : name;
}

/**
 * A folder name to start from, read off a registry name: its last segment in
 * lower snake case. The person may change it.
 */
export function suggestedServerName(registryRef: string): string {
  const last = registryRef.split("/").pop() ?? "";
  return last
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .slice(0, SERVER_NAME_MAX)
    .replace(/_+$/, "");
}

/** The name, label, and description every server.toml carries. */
type Heading = { name: string; label: string; description: string };

function headingProblems(heading: Heading): MachineProblem[] {
  const problems: MachineProblem[] = [];
  if (heading.name === BUILTIN_SERVER) {
    problems.push({ kind: "reserved" });
  } else if (!SERVER_NAME_PATTERN.test(heading.name)) {
    problems.push({ kind: "name" });
  }
  if (heading.label === "" || heading.label.length > LABEL_MAX) {
    problems.push({ kind: "label" });
  }
  if (
    heading.description === "" ||
    heading.description.length > DESCRIPTION_MAX
  ) {
    problems.push({ kind: "description" });
  }
  return problems;
}

function groupProblems(groups: readonly string[]): MachineProblem[] {
  if (groups.length === 0 || groups.length > GROUPS_MAX) {
    return [{ kind: "machines" }];
  }
  return groups
    .filter((group) => !MACHINE_GROUP.test(group))
    .map((group) => ({ kind: "machine" as const, group }));
}

function variableProblems(names: readonly string[]): MachineProblem[] {
  return names
    .filter((name) => !VARIABLE_NAME.test(name))
    .map((name) => ({ kind: "variable" as const, name }));
}

function headingToml(heading: Heading): string[] {
  return [
    `schema = "mcp-server/v1"`,
    `name = ${tomlString(heading.name)}`,
    `label = ${tomlString(heading.label)}`,
    `description = ${tomlString(heading.description)}`,
    "",
  ];
}

function footerToml(schedule: "manual" | "daily"): string[] {
  return [
    "[exposure]",
    `mode = "direct"`,
    "",
    "[sync]",
    `schedule = ${tomlString(schedule)}`,
    "",
  ];
}

/** What the Local command form holds at submit. */
type LocalForm = Heading & {
  command: string;
  /** One argument per line. */
  arguments: string;
  /** One variable name per line. */
  variables: string;
  /** One machine group per line. */
  machines: string;
  version: string;
  digest: string;
};

/**
 * Check the Local command form and build the new server's draft and pin, or
 * name every problem. Text fields are trimmed first.
 */
export function newLocalServer(raw: LocalForm): Built {
  const heading = {
    name: raw.name.trim(),
    label: raw.label.trim(),
    description: raw.description.trim(),
  };
  const command = raw.command.trim();
  const args = linesOf(raw.arguments);
  const variables = uniqueLines(raw.variables);
  const groups = uniqueLines(raw.machines);
  const version = raw.version.trim();
  const digest = normalizeDigest(raw.digest);

  const problems = headingProblems(heading);
  if (command === "" || command.length > COMMAND_MAX) {
    problems.push({ kind: "command" });
  }
  if (
    args.length > ARGUMENTS_MAX ||
    args.some((arg) => arg.length > ARGUMENT_MAX)
  ) {
    problems.push({ kind: "arguments" });
  }
  if (variables.length > VARIABLES_MAX) problems.push({ kind: "variables" });
  problems.push(...variableProblems(variables));
  problems.push(...groupProblems(groups));
  if (version === "" || version.length > VERSION_MAX) {
    problems.push({ kind: "version" });
  }
  if (digest === null) problems.push({ kind: "digest" });
  if (problems.length > 0 || digest === null) return { ok: false, problems };

  const source = [
    "[source]",
    `type = "local"`,
    `command = ${tomlString(command)}`,
    ...(args.length === 0 ? [] : [`args = ${tomlArray(args)}`]),
    ...(variables.length === 0 ? [] : [`env = ${tomlArray(variables)}`]),
    `machines = ${tomlArray(groups)}`,
    "",
  ];
  return {
    ok: true,
    value: {
      server: {
        server: heading.name,
        serverToml: [
          ...headingToml(heading),
          ...source,
          ...footerToml("manual"),
        ].join("\n"),
      },
      pin: { version, digest },
    },
  };
}

/** One argument the package form asks for, as the person filled it in. */
type PackageArgumentValue = {
  /** The key source.arguments uses (argumentKey). */
  key: string;
  /** What the person typed. A secret argument has none. */
  value: string;
  secret: boolean;
};

/** What the registry package form holds at submit. */
type PackageForm = Heading & {
  /** The registry name, such as io.github.acme/notes. */
  registryRef: string;
  /** The catalog version the search listed, or null when it listed none. */
  entryVersion: string | null;
  registryType: PinnedPackageType;
  /** One machine group per line. */
  machines: string;
  /** The required arguments the registry gives no fixed value. */
  arguments: readonly PackageArgumentValue[];
  /** The variables the package requires. source.env lists every one. */
  variables: readonly string[];
};

/**
 * Check the registry package form and build the new server's draft, or name
 * every problem. A registry package sends no pin: Oxagen reads its digest.
 */
export function newPackageServer(raw: PackageForm): Built {
  const heading = {
    name: raw.name.trim(),
    label: raw.label.trim(),
    description: raw.description.trim(),
  };
  const groups = uniqueLines(raw.machines);
  const problems = headingProblems(heading);
  problems.push(...groupProblems(groups));
  if (raw.entryVersion === null || raw.entryVersion === "") {
    problems.push({ kind: "entryVersion" });
  }

  const values: [string, string][] = [];
  const env = new Set(raw.variables);
  for (const argument of raw.arguments) {
    if (argument.secret) {
      const name = secretVariable(argument.key);
      values.push([argument.key, `\${${name}}`]);
      env.add(name);
      continue;
    }
    const value = argument.value.trim();
    if (value === "") {
      problems.push({ kind: "argumentRequired", argument: argument.key });
    } else if (value.length > ARGUMENT_MAX || !ARGUMENT_VALUE.test(value)) {
      problems.push({ kind: "argumentInvalid", argument: argument.key });
    } else {
      values.push([argument.key, value]);
      for (const name of templateVariables(value)) env.add(name);
    }
  }
  problems.push(...variableProblems([...env]));
  if (problems.length > 0 || raw.entryVersion === null) {
    return { ok: false, problems };
  }

  const names = [...env];
  const source = [
    "[source]",
    `type = "registry"`,
    `registry = ${tomlString(OFFICIAL_REGISTRY)}`,
    `server = ${tomlString(raw.registryRef)}`,
    `version = ${tomlString(raw.entryVersion)}`,
    `machines = ${tomlArray(groups)}`,
    `registry_type = ${tomlString(raw.registryType)}`,
    ...(names.length === 0 ? [] : [`env = ${tomlArray(names)}`]),
    "",
    ...(values.length === 0
      ? []
      : [
          "[source.arguments]",
          ...values.map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`),
          "",
        ]),
  ];
  return {
    ok: true,
    value: {
      server: {
        server: heading.name,
        serverToml: [
          ...headingToml(heading),
          ...source,
          ...footerToml("daily"),
        ].join("\n"),
      },
    },
  };
}
