/**
 * How the local gateway turns a launch spec into the command it runs
 * (mcp-studio-spec, Local servers and Registry packages).
 *
 * The lock keeps each `${NAME}` in args for the machine to fill, and `$$`
 * for a literal `$`. The machine fills only the names source.env lists, and
 * the server receives only those variables plus a fixed base the runners
 * need to start. Every other variable on the machine, such as a cloud
 * credential, never reaches it.
 *
 * A registry package must also have the shape the spec's launch table gives
 * it, so a launch that names the locked package cannot run a different one
 * through extra runner flags.
 */
import { launchMismatch, missingVariable, type LocalServerRefusal } from "./errors";
import type { LaunchPackage, LaunchSpec, RegistryType } from "./wire";

/** Lane M0's template token: `$$`, or `${NAME}` with an environment variable name. */
const TEMPLATE_TOKEN = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}/g;

/**
 * The variables every server receives when the machine sets them, so its
 * runner can start: the Unix base, then the Windows names a process needs.
 */
export const BASE_ENV_NAMES = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "PATHEXT",
  "COMSPEC",
] as const;

/** How the local gateway runs one package type, as lane M0's REGISTRY_RUNNERS gives it. */
export interface RegistryRunner {
  command: string;
  /** The flags the args start with. For oci, a `-e NAME` pair for each source.env name follows them. */
  flags: readonly string[];
  /**
   * What the launch pins. `version` and `digest` follow the package after an
   * @. `file` installs one file of the release with `--from <url> <name>`,
   * because a PyPI release holds one file per host (ADR-233).
   */
  pin: "version" | "digest" | "file";
}

/** The spec's launch table, a copy of lane M0's (packages/mcp-studio/src/model/registry-launch.ts). */
export const REGISTRY_RUNNERS: Readonly<Record<RegistryType, RegistryRunner>> = {
  npm: { command: "npx", flags: ["--yes"], pin: "version" },
  pypi: { command: "uvx", flags: [], pin: "file" },
  oci: { command: "docker", flags: ["run", "--rm", "-i"], pin: "digest" },
  nuget: { command: "dnx", flags: ["--yes"], pin: "version" },
};

/** The machine's environment, as `process.env` gives it. */
export type MachineEnv = Readonly<Record<string, string | undefined>>;

/** A launch with its args filled and its environment built: what the gateway spawns. */
export interface PreparedLaunch {
  server: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  package: LaunchPackage;
}

export type LaunchPreparation =
  | { ok: true; launch: PreparedLaunch }
  | { ok: false; refusal: LocalServerRefusal };

/** Text as a lock arg writes it, with each `$` written `$$` so the gateway fills nothing in it. */
function literal(text: string): string {
  return text.split("$").join("$$");
}

/**
 * Why a registry package's launch does not have the launch table's shape,
 * or undefined when it does. A local server has no registry_type and no
 * table row, so it always passes.
 */
export function launchShapeProblem(spec: LaunchSpec): string | undefined {
  const type = spec.package.registry_type;
  if (type === undefined) return undefined;
  const runner = REGISTRY_RUNNERS[type];
  if (spec.command !== runner.command) {
    return `a ${type} package runs with ${runner.command}, and the launch runs ${spec.command}`;
  }
  const lead = [...runner.flags, ...(type === "oci" ? spec.env.flatMap((name) => ["-e", name]) : [])];
  if (lead.some((word, index) => spec.args[index] !== word)) {
    return `a ${type} launch starts with ${lead.join(" ")}`;
  }
  const rest = spec.args.slice(lead.length);
  if (runner.pin === "file") {
    // The digester hashes the file at the URL, so the URL is the pin.
    const at = rest.indexOf("--from");
    const url = at < 0 ? undefined : rest[at + 1];
    if (url === undefined || !url.startsWith("https://") || rest[at + 2] !== literal(spec.package.name)) {
      return `the args do not install the locked package ${spec.package.name} from one file with --from <url>`;
    }
    return undefined;
  }
  const pin = runner.pin === "digest" ? spec.package.digest : spec.package.version;
  const reference = `${literal(spec.package.name)}@${literal(pin)}`;
  if (!rest.includes(reference)) {
    return `the args do not name the locked package ${spec.package.name}@${pin}`;
  }
  return undefined;
}

/** The first `${NAME}` in args that source.env does not list. */
function unlistedName(args: readonly string[], listed: ReadonlySet<string>): string | undefined {
  for (const arg of args) {
    for (const match of arg.matchAll(TEMPLATE_TOKEN)) {
      const name = match[1];
      if (name !== undefined && !listed.has(name)) return name;
    }
  }
  return undefined;
}

/**
 * Check a launch against its runner's shape and the machine's environment,
 * then fill its args and build the server's environment.
 */
export function prepareLaunch(spec: LaunchSpec, env: MachineEnv): LaunchPreparation {
  const shape = launchShapeProblem(spec);
  if (shape !== undefined) return { ok: false, refusal: launchMismatch(shape) };

  const listed = new Set(spec.env);
  const unlisted = unlistedName(spec.args, listed);
  if (unlisted !== undefined) {
    return {
      ok: false,
      refusal: launchMismatch(`an argument names \${${unlisted}}, which the launch's env does not list`),
    };
  }

  const values = new Map<string, string>();
  for (const name of spec.env) {
    const value = env[name];
    if (value === undefined) return { ok: false, refusal: missingVariable(name) };
    values.set(name, value);
  }

  const childEnv: Record<string, string> = {};
  for (const name of BASE_ENV_NAMES) {
    const value = env[name];
    if (value !== undefined) childEnv[name] = value;
  }
  for (const [name, value] of values) childEnv[name] = value;

  const args = spec.args.map((arg) =>
    // Every name here is listed and set, as the checks above found.
    arg.replace(TEMPLATE_TOKEN, (_token: string, name: string | undefined) =>
      name === undefined ? "$" : (values.get(name) as string),
    ),
  );
  return {
    ok: true,
    launch: { server: spec.server, command: spec.command, args, env: childEnv, package: spec.package },
  };
}
