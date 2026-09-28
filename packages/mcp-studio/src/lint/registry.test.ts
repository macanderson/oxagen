// lint: the registry rows of the Tool checks table. Each rule has a folder
// that trips it and one that does not. A drift table holds lint's registry
// errors to registryLaunch's problems, field for field, on every case
// registry-launch.test.ts runs. Another holds registry_without_remote to the
// remotes registryLockSource pins.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseServerToml, type ReadResult } from "../contract/parse";
import { registryEntrySchema, type RegistryEntry } from "../contract/registry-entry";
import { registrySourceSchema } from "../contract/server";
import { mcpToolsSchema } from "../contract/tools";
import { registryLockSource } from "../lock";
import { registryLaunch, type RegistrySource } from "../model/registry-launch";
import { lint, LINT_RULES, type Finding, type LintContext, type LintRule, type ServerFolder } from "./index";

const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));

function text(path: string): string {
  return readFileSync(join(FIXTURES, path), "utf8");
}

/** The value of a parse that must succeed. A failure shows its issues. */
function ok<T>(result: ReadResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
  return result.value;
}

const byText = (a: string, b: string): number => a.localeCompare(b);

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** The spec's files server: npm on dev-laptops, with ${WORK_DIR} as its directory. */
const FILES = ok(parseServerToml(text("servers/files/server.toml")));
const FILES_SOURCE = FILES.source as RegistrySource;
/** The entry FILES pins: one npm package whose positional argument takes a directory. */
const PACKAGE_ENTRY = registryEntrySchema.parse(JSON.parse(text("registry/package-entry.json")));
/** An entry with one streamable-http remote and no package. */
const REMOTE_ENTRY = registryEntrySchema.parse(JSON.parse(text("registry/remote-entry.json")));

const CONTEXT: LintContext = { credentials: new Set(), accepted_unchanged: new Set() };

// ── Builders ─────────────────────────────────────────────────────────────────

const digest = `sha256:${"0d4c".repeat(16)}`;

const catalog = {
  type: "registry",
  registry: "https://registry.modelcontextprotocol.io",
  server: "io.github.acme/files",
  version: "1.4.0",
};

/** A parsed registry source on dev-laptops with the given fields. */
function source(fields: Record<string, unknown>): RegistrySource {
  return registrySourceSchema.parse({ ...catalog, machines: ["dev-laptops"], ...fields }) as RegistrySource;
}

/** A parsed catalog entry at version 1.4.0 with the given packages. */
function entry(...packages: Record<string, unknown>[]): RegistryEntry {
  return registryEntrySchema.parse({
    server: { name: catalog.server, description: "Files on the machine.", version: "1.4.0", packages },
  });
}

/** A parsed catalog entry at version 1.4.0 with these remotes and one npm package. */
function withRemotes(...types: string[]): RegistryEntry {
  return registryEntrySchema.parse({
    server: {
      name: catalog.server,
      description: "Files on the machine.",
      version: "1.4.0",
      packages: [npm()],
      remotes: types.map((type) => ({ type, url: "https://mcp.acme.example/mcp" })),
    },
  });
}

const stdio = { type: "stdio" };

const npm = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  registryType: "npm",
  identifier: "@acme/files",
  version: "1.4.0",
  transport: stdio,
  ...fields,
});

const onNpm = (fields: Record<string, unknown> = {}): RegistrySource => source({ registry_type: "npm", ...fields });

/** A source on machines with no registry_type, which parse refuses and a draft can hold. */
function withoutRegistryType(value: RegistrySource): RegistrySource {
  const copy: Partial<RegistrySource> = { ...value };
  delete copy.registry_type;
  return copy as RegistrySource;
}

/** The files folder with this source, no tools, and the entry at source.version when given. */
function folder(value: RegistrySource, registry_entry?: RegistryEntry): ServerFolder {
  return {
    name: FILES.name,
    server: { ...FILES, source: value },
    tools: mcpToolsSchema.parse({ schema: "mcp-tools/v1" }),
    lock: undefined,
    offered: [],
    notes: [],
    registry_entry,
  };
}

// ── Assertions ───────────────────────────────────────────────────────────────

type Found = [LintRule, string | undefined, string | undefined];

function found(findings: readonly Finding[]): Found[] {
  return findings.map((finding) => [finding.rule, finding.tool, finding.field]);
}

/** Every finding has the rule's level, the six fields, and a message and fix that are sentences. */
function expectShape(findings: readonly Finding[]): void {
  for (const finding of findings) {
    expect(Object.keys(finding).sort(byText)).toEqual(["field", "fix", "level", "message", "rule", "tool"]);
    expect(finding.level).toBe(LINT_RULES[finding.rule].level);
    expect(finding.message).toMatch(/\S\.$/);
    expect(finding.fix).toMatch(/\S\.$/);
  }
}

/** Fields in a fixed order, with undefined as "", so two lists compare as sets with repeats. */
function sorted(values: readonly (string | undefined)[]): string[] {
  return values.map((value) => value ?? "").sort(byText);
}

// ── Rules ────────────────────────────────────────────────────────────────────

interface Case {
  name: string;
  folder: ServerFolder;
  found: Found[];
}

const REQUIRED_ROOT = npm({ packageArguments: [{ type: "named", name: "--root", isRequired: true }] });
const REQUIRED_KEY = npm({ environmentVariables: [{ name: "API_KEY", isRequired: true }, { name: "LOG_LEVEL" }] });
const SECRET_TOKEN = npm({ packageArguments: [{ type: "named", name: "--token", isSecret: true }] });
const PYPI_ONLY = entry({ registryType: "pypi", identifier: "mcp-server-files", transport: stdio });

const CASES: Case[] = [
  { name: "the files fixture with its entry", folder: folder(FILES_SOURCE, PACKAGE_ENTRY), found: [] },
  { name: "the files fixture before the entry is read", folder: folder(FILES_SOURCE), found: [] },
  {
    name: "registry_without_remote: a cloud source whose entry lists no remote",
    folder: folder(registrySourceSchema.parse(catalog) as RegistrySource, entry(npm())),
    found: [["registry_without_remote", undefined, "source.machines"]],
  },
  {
    name: "registry_without_remote: a cloud source whose entry lists a remote",
    folder: folder(registrySourceSchema.parse(catalog) as RegistrySource, REMOTE_ENTRY),
    found: [],
  },
  {
    name: "registry_without_remote: a cloud source whose entry lists only an sse remote",
    folder: folder(registrySourceSchema.parse(catalog) as RegistrySource, withRemotes("sse")),
    found: [["registry_without_remote", undefined, "source.machines"]],
  },
  {
    name: "registry_without_remote: source.machines that names no group",
    folder: folder(source({ machines: [], registry_type: "npm" }), entry(npm())),
    found: [["registry_without_remote", undefined, "source.machines"]],
  },
  {
    name: "package_cannot_run: no package of source.registry_type",
    folder: folder(onNpm(), PYPI_ONLY),
    found: [["package_cannot_run", undefined, "source.registry_type"]],
  },
  {
    name: "package_cannot_run: no source.registry_type, before the entry is read",
    folder: folder(withoutRegistryType(FILES_SOURCE)),
    found: [["package_cannot_run", undefined, "source.registry_type"]],
  },
  {
    name: "argument_without_value: a required argument with no value",
    folder: folder(onNpm(), entry(REQUIRED_ROOT)),
    found: [["argument_without_value", undefined, "source.arguments.--root"]],
  },
  {
    name: "argument_without_value: a required argument source.arguments sets",
    folder: folder(onNpm({ arguments: { "--root": "/srv" } }), entry(REQUIRED_ROOT)),
    found: [],
  },
  {
    name: "env_variable_missing: an argument's ${NAME} that source.env does not list",
    folder: folder({ ...FILES_SOURCE, arguments: { directory: "${ROOT}" } }, PACKAGE_ENTRY),
    found: [["env_variable_missing", undefined, "source.arguments.directory"]],
  },
  {
    name: "env_variable_missing: a variable the package requires",
    folder: folder(onNpm(), entry(REQUIRED_KEY)),
    found: [["env_variable_missing", undefined, "source.env"]],
  },
  {
    name: "env_variable_missing: a required variable source.env lists",
    folder: folder(onNpm({ env: ["API_KEY"] }), entry(REQUIRED_KEY)),
    found: [],
  },
  {
    name: "secret_literal: a secret set to a literal",
    folder: folder(onNpm({ env: ["TOKEN"], arguments: { "--token": "Bearer ${TOKEN}" } }), entry(SECRET_TOKEN)),
    found: [["secret_literal", undefined, "source.arguments.--token"]],
  },
  {
    name: "secret_literal: a secret set to one variable",
    folder: folder(onNpm({ env: ["TOKEN"], arguments: { "--token": "${TOKEN}" } }), entry(SECRET_TOKEN)),
    found: [],
  },
];

describe("lint's registry checks", () => {
  it.each(CASES)("$name", ({ folder: value, found: expected }) => {
    const findings = lint(value, CONTEXT);
    expect(found(findings)).toStrictEqual(expected);
    expectShape(findings);
  });

  it("trips every registry rule in a case above", () => {
    const tripped = new Set(CASES.flatMap((each) => each.found.map(([rule]) => rule)));
    const rules = Object.entries(LINT_RULES)
      .filter(([, rule]) => JSON.stringify(rule.sources) === JSON.stringify(["registry"]))
      .map(([name]) => name);
    expect([...tripped].sort(byText)).toStrictEqual(rules.sort(byText));
  });

  it("offers another package type, the remote, or another version", () => {
    const fixOf = (value: RegistryEntry): string | undefined => lint(folder(onNpm(), value), CONTEXT)[0]?.fix;
    const remoteOnly = registryEntrySchema.parse({
      server: {
        name: catalog.server,
        description: "Files on the machine.",
        version: "1.4.0",
        remotes: [{ type: "streamable-http", url: "https://mcp.acme.example/mcp" }],
      },
    });

    expect(fixOf(PYPI_ONLY)).toBe('Set source.registry_type to "pypi" in server.toml.');
    expect(fixOf(remoteOnly)).toBe(
      "Remove source.machines, registry_type, env, and arguments from server.toml and add auth, so the cloud gateway connects to the entry's remote.",
    );
    expect(fixOf(entry())).toBe(
      "Set source.version to a catalog version whose entry lists one npm, pypi, oci, or nuget package that serves stdio.",
    );
  });

  it("offers only a package type, or a remote, that would run", () => {
    const fixOf = (value: RegistryEntry): string | undefined => lint(folder(onNpm(), value), CONTEXT)[0]?.fix;
    const version =
      "Set source.version to a catalog version whose entry lists one npm, pypi, oci, or nuget package that serves stdio.";
    const pypi = (fields: Record<string, unknown>): Record<string, unknown> => ({
      registryType: "pypi",
      identifier: "mcp-server-files",
      transport: stdio,
      ...fields,
    });

    expect(fixOf(entry(pypi({ transport: { type: "streamable-http", url: "http://localhost:8080/mcp" } })))).toBe(
      version,
    );
    expect(fixOf(entry(pypi({ runtimeHint: "python" })))).toBe(version);
    expect(fixOf(entry(pypi({ packageArguments: [{ type: "positional" }] })))).toBe(version);
    expect(fixOf(entry(pypi({ runtimeHint: "uvx" })))).toBe('Set source.registry_type to "pypi" in server.toml.');

    const sseOnly = registryEntrySchema.parse({
      server: {
        name: catalog.server,
        description: "Files on the machine.",
        version: "1.4.0",
        remotes: [{ type: "sse", url: "https://mcp.acme.example/sse" }],
      },
    });
    expect(fixOf(sseOnly)).toBe(version);
  });

  it("says the cloud gateway calls only streamable-http remotes", () => {
    const [finding] = lint(folder(registrySourceSchema.parse(catalog) as RegistrySource, withRemotes("sse")), CONTEXT);
    expect(finding?.message).toBe(
      "The catalog entry for io.github.acme/files 1.4.0 lists no streamable-http remote, and source.machines names no machine group, so the server runs nowhere. The cloud gateway calls only streamable-http remotes.",
    );
  });

  it("names the mcpb bundle the local gateway cannot run", () => {
    const bundle = entry({ registryType: "mcpb", identifier: "https://acme.example/files.mcpb", transport: stdio });
    const [finding] = lint(folder(onNpm(), bundle), CONTEXT);
    expect(finding?.message).toBe(
      "The catalog entry lists no npm package, and the local gateway cannot run its mcpb bundle, so nothing could start the server.",
    );
  });

  it("names the types to set when the entry is not read", () => {
    const [finding] = lint(folder(withoutRegistryType(FILES_SOURCE)), CONTEXT);
    expect(finding?.fix).toBe("Set source.registry_type to the type of the entry's package: npm, pypi, oci, or nuget.");
  });
});

// ── lint and registryLaunch ──────────────────────────────────────────────────

interface Launch {
  name: string;
  source: RegistrySource;
  entry: RegistryEntry;
  /** The fields registryLaunch refuses, and lint reports an error on. */
  fields: string[];
}

const REGION = { variables: { region: { default: "us" } } };
const REGION_ARGUMENT = [{ type: "named", name: "--region", default: "{region}", ...REGION }];
const SECRET_KEY = [{ type: "named", name: "--key", default: "abc123", isSecret: true }];

/** Every case registry-launch.test.ts runs, with the fields each refuses. */
const LAUNCHES: Launch[] = [
  // Launches.
  { name: "the files fixture", source: FILES_SOURCE, entry: PACKAGE_ENTRY, fields: [] },
  {
    name: "an oci image with docker",
    source: source({ registry_type: "oci", env: ["API_KEY", "LOG_LEVEL"] }),
    entry: entry({
      registryType: "oci",
      identifier: "ghcr.io/acme/files",
      version: "1.4.0",
      transport: stdio,
      runtimeHint: "docker",
      environmentVariables: [{ name: "API_KEY", isRequired: true }, { name: "LOG_LEVEL" }],
      packageArguments: [{ type: "named", name: "--root", default: "/data" }],
    }),
    fields: [],
  },
  {
    name: "a pypi package",
    source: source({ registry_type: "pypi" }),
    entry: entry({ registryType: "pypi", identifier: "mcp-server-files", transport: stdio }),
    fields: [],
  },
  {
    name: "a nuget package with dnx",
    source: source({ registry_type: "nuget", arguments: { root: "/srv", "--port": "8080" } }),
    entry: entry({
      registryType: "nuget",
      identifier: "Acme.Files.Mcp",
      version: "2.0.1",
      transport: stdio,
      runtimeHint: "dnx",
      runtimeArguments: [{ type: "named", name: "--source", value: "https://api.nuget.org/v3/index.json" }],
      packageArguments: [
        { type: "positional", value: "serve" },
        { type: "named", name: "--port", valueHint: "port" },
        { type: "positional", valueHint: "root", isRequired: true },
      ],
    }),
    fields: [],
  },
  {
    name: "optional arguments with no value",
    source: onNpm(),
    entry: entry(
      npm({
        packageArguments: [
          { type: "named", name: "--verbose" },
          { type: "positional", valueHint: "root", default: "." },
          { type: "named", name: "--mode", value: "stdio" },
        ],
      }),
    ),
    fields: [],
  },
  {
    name: "a $ in the entry's text",
    source: onNpm({ env: ["TOKEN"], arguments: { "--token": "${TOKEN}" } }),
    entry: entry(
      npm({
        identifier: "@acme/files$",
        version: "1.4.0$beta",
        packageArguments: [
          { type: "named", name: "--price$", default: "5$" },
          { type: "named", name: "--token", isSecret: true },
        ],
      }),
    ),
    fields: [],
  },
  {
    name: "fixed arguments that share a name",
    source: onNpm(),
    entry: entry(
      npm({
        packageArguments: [
          { type: "named", name: "--volume", value: "/a" },
          { type: "named", name: "--volume", value: "/b" },
        ],
      }),
    ),
    fields: [],
  },
  {
    name: "a secret set to one variable",
    source: onNpm({ env: ["KEY"], arguments: { "--key": "${KEY}" } }),
    entry: entry(npm({ packageArguments: SECRET_KEY })),
    fields: [],
  },
  {
    name: "a registry variable source.arguments sets",
    source: onNpm({ arguments: { "--region": "eu" } }),
    entry: entry(npm({ packageArguments: REGION_ARGUMENT })),
    fields: [],
  },

  // Problems.
  { name: "no npm package", source: onNpm(), entry: entry(), fields: ["source.registry_type"] },
  {
    name: "two npm packages",
    source: onNpm(),
    entry: entry(npm(), npm({ identifier: "@acme/other" })),
    fields: ["source.registry_type"],
  },
  {
    name: "a streamable-http package run with bunx",
    source: onNpm(),
    entry: entry(npm({ transport: { type: "streamable-http", url: "http://localhost:8080/mcp" }, runtimeHint: "bunx" })),
    fields: ["source.registry_type", "source.registry_type"],
  },
  { name: "a required environment variable", source: onNpm(), entry: entry(REQUIRED_KEY), fields: ["source.env"] },
  {
    name: "positional arguments source.arguments cannot key",
    source: onNpm(),
    entry: entry(
      npm({
        runtimeArguments: [{ type: "positional", valueHint: "root" }],
        packageArguments: [{ type: "positional" }, { type: "positional", valueHint: "root" }],
      }),
    ),
    fields: ["source.registry_type", "source.arguments.root"],
  },
  {
    name: "a key the entry fixes, and a key it does not take",
    source: onNpm({ arguments: { "--mode": "http", "--port": "8080" } }),
    entry: entry(npm({ packageArguments: [{ type: "named", name: "--mode", value: "stdio" }] })),
    fields: ["source.arguments.--mode", "source.arguments.--port"],
  },
  {
    name: "a secret set to a literal",
    source: onNpm({ env: ["TOKEN"], arguments: { "--token": "Bearer ${TOKEN}" } }),
    entry: entry(SECRET_TOKEN),
    fields: ["source.arguments.--token"],
  },
  {
    name: "a key a fixed argument shares with a settable one",
    source: onNpm({ arguments: { "--port": "9000" } }),
    entry: entry(
      npm({
        packageArguments: [
          { type: "named", name: "--port", value: "8000" },
          { type: "named", name: "--port" },
        ],
      }),
    ),
    fields: ["source.arguments.--port"],
  },
  {
    name: "secrets whose values come from the entry",
    source: onNpm(),
    entry: entry(
      npm({
        runtimeArguments: [{ type: "named", name: "--token", value: "hunter2", isSecret: true }],
        packageArguments: SECRET_KEY,
      }),
    ),
    fields: ["source.registry_type", "source.arguments.--key"],
  },
  {
    name: "registry variables the local gateway would fill",
    source: onNpm(),
    entry: entry(
      npm({
        runtimeArguments: [{ type: "named", name: "--registry", value: "https://{region}.npm.acme.dev", ...REGION }],
        packageArguments: REGION_ARGUMENT,
      }),
    ),
    fields: ["source.registry_type", "source.arguments.--region"],
  },
  { name: "a required argument with no value", source: onNpm(), entry: entry(REQUIRED_ROOT), fields: ["source.arguments.--root"] },
  {
    name: "a required argument with no key",
    source: onNpm(),
    entry: entry(npm({ packageArguments: [{ type: "positional", isRequired: true }] })),
    fields: ["source.registry_type", "source.registry_type"],
  },
  // registryLaunch's cloud case has no machines, where lint reads no package. This is the same refusal on machines.
  { name: "no source.registry_type", source: withoutRegistryType(onNpm()), entry: entry(npm()), fields: ["source.registry_type"] },
];

describe("lint and registryLaunch", () => {
  it.each(LAUNCHES)("agree on $name", ({ source: value, entry: pinned, fields }) => {
    const launch = registryLaunch({ source: value, entry: pinned, digest });
    const errors = lint(folder(value, pinned), CONTEXT).filter((finding) => finding.level === "error");

    expect(sorted(launch.ok ? [] : launch.problems.map((problem) => problem.field))).toStrictEqual(sorted(fields));
    expect(sorted(errors.map((finding) => finding.field))).toStrictEqual(sorted(fields));
    expectShape(errors);
  });
});

// ── lint and registryLockSource ──────────────────────────────────────────────

describe("registry_without_remote and the lock", () => {
  const cloud = registrySourceSchema.parse(catalog) as RegistrySource;
  const REMOTES: { name: string; entry: RegistryEntry }[] = [
    { name: "no remote", entry: withRemotes() },
    { name: "an sse remote", entry: withRemotes("sse") },
    { name: "a streamable-http remote", entry: withRemotes("streamable-http") },
    { name: "an sse and a streamable-http remote", entry: withRemotes("sse", "streamable-http") },
  ];

  it.each(REMOTES)("reports the rule exactly when the lock refuses $name", ({ entry: value }) => {
    const refused = (() => {
      try {
        registryLockSource({ source: cloud, entry: value, digest: undefined, server_version: undefined });
        return false;
      } catch {
        return true;
      }
    })();
    const reported = lint(folder(cloud, value), CONTEXT).some((finding) => finding.rule === "registry_without_remote");
    expect(reported).toBe(refused);
  });
});
