// registryLaunch: the spec's launch table for each package type, and every
// reason a registry entry's package cannot run on the local gateway.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { registryEntrySchema, type RegistryEntry } from "../contract/registry-entry";
import { registrySourceSchema } from "../contract/server";
import { REGISTRY_RUNNERS, registryLaunch, type RegistrySource } from "./registry-launch";

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

const stdio = { type: "stdio" };

describe("the launch table", () => {
  it("runs npx --yes for the spec's files server", () => {
    const files = registryEntrySchema.parse(
      JSON.parse(readFileSync(new URL("../../fixtures/registry/package-entry.json", import.meta.url), "utf8")),
    );
    const launch = registryLaunch({
      source: source({ registry_type: "npm", env: ["WORK_DIR"], arguments: { directory: "${WORK_DIR}" } }),
      entry: files,
      digest,
    });
    expect(launch).toStrictEqual({
      ok: true,
      command: "npx",
      args: ["--yes", "@modelcontextprotocol/server-filesystem@2026.8.1", "${WORK_DIR}"],
      package: { name: "@modelcontextprotocol/server-filesystem", version: "2026.8.1", digest, registry_type: "npm" },
    });
  });

  it("runs docker with -e for each source.env name and pins the image by digest", () => {
    const image = {
      registryType: "oci",
      identifier: "ghcr.io/acme/files",
      version: "1.4.0",
      transport: stdio,
      runtimeHint: "docker",
      environmentVariables: [{ name: "API_KEY", isRequired: true }, { name: "LOG_LEVEL" }],
      packageArguments: [{ type: "named", name: "--root", default: "/data" }],
    };
    const launch = registryLaunch({
      source: source({ registry_type: "oci", env: ["API_KEY", "LOG_LEVEL"] }),
      entry: entry(image),
      digest,
    });
    expect(launch).toStrictEqual({
      ok: true,
      command: "docker",
      args: ["run", "--rm", "-i", "-e", "API_KEY", "-e", "LOG_LEVEL", `ghcr.io/acme/files@${digest}`, "--root", "/data"],
      package: { name: "ghcr.io/acme/files", version: "1.4.0", digest, registry_type: "oci" },
    });
  });

  it("names a pypi package at the entry's version when no file is pinned yet, to read its name and version", () => {
    const pkg = { registryType: "pypi", identifier: "mcp-server-files", transport: stdio };
    expect(registryLaunch({ source: source({ registry_type: "pypi" }), entry: entry(pkg), digest })).toStrictEqual({
      ok: true,
      command: "uvx",
      args: ["mcp-server-files@1.4.0"],
      package: { name: "mcp-server-files", version: "1.4.0", digest, registry_type: "pypi" },
    });
  });

  it("installs a pypi package's one pinned file with uvx --from, after the runtime arguments (ADR-233)", () => {
    const wheel = "https://files.pythonhosted.org/packages/ab/cd/mcp_server_files-1.4.0-py3-none-any.whl";
    const file = { name: "mcp_server_files-1.4.0-py3-none-any.whl", url: wheel };
    const pkg = {
      registryType: "pypi",
      identifier: "mcp-server-files",
      transport: stdio,
      runtimeArguments: [{ type: "named", name: "--python", value: "3.12" }],
      packageArguments: [{ type: "positional", value: "serve" }],
    };
    expect(
      registryLaunch({ source: source({ registry_type: "pypi" }), entry: entry(pkg), digest, file }),
    ).toStrictEqual({
      ok: true,
      command: "uvx",
      args: ["--python", "3.12", "--from", wheel, "mcp-server-files", "serve"],
      package: { name: "mcp-server-files", version: "1.4.0", digest, registry_type: "pypi", file },
    });
  });

  it("names no file for a package that is not pypi", () => {
    const pkg = { registryType: "npm", identifier: "@acme/files-mcp", transport: stdio };
    const file = { name: "x.whl", url: "https://files.pythonhosted.org/x.whl" };
    const launch = registryLaunch({ source: source({ registry_type: "npm" }), entry: entry(pkg), digest, file });
    if (!launch.ok) throw new Error(JSON.stringify(launch.problems));
    expect(launch.args).toContain("@acme/files-mcp@1.4.0");
    expect(launch.package).not.toHaveProperty("file");
  });

  it("runs dnx --yes, with runtimeArguments before the package reference", () => {
    const pkg = {
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
    };
    const launch = registryLaunch({
      source: source({ registry_type: "nuget", arguments: { root: "/srv", "--port": "8080" } }),
      entry: entry(pkg),
      digest,
    });
    expect(launch).toStrictEqual({
      ok: true,
      command: "dnx",
      args: [
        "--yes",
        "--source",
        "https://api.nuget.org/v3/index.json",
        "Acme.Files.Mcp@2.0.1",
        "serve",
        "--port",
        "8080",
        "/srv",
      ],
      package: { name: "Acme.Files.Mcp", version: "2.0.1", digest, registry_type: "nuget" },
    });
  });

  it("names every runner the spec names", () => {
    expect(REGISTRY_RUNNERS).toStrictEqual({
      npm: { command: "npx", flags: ["--yes"], pin: "version" },
      pypi: { command: "uvx", flags: [], pin: "file" },
      oci: { command: "docker", flags: ["run", "--rm", "-i"], pin: "digest" },
      nuget: { command: "dnx", flags: ["--yes"], pin: "version" },
    });
  });
});

describe("the args", () => {
  const npm = (fields: Record<string, unknown>) => ({
    registryType: "npm",
    identifier: "@acme/files",
    version: "1.4.0",
    transport: stdio,
    ...fields,
  });

  it("leaves out an optional argument with no value, and keeps entry order", () => {
    const pkg = npm({
      packageArguments: [
        { type: "named", name: "--verbose" },
        { type: "positional", valueHint: "root", default: "." },
        { type: "named", name: "--mode", value: "stdio" },
      ],
    });
    const launch = registryLaunch({ source: source({ registry_type: "npm" }), entry: entry(pkg), digest });
    expect(launch.ok && launch.args).toStrictEqual(["--yes", "@acme/files@1.4.0", ".", "--mode", "stdio"]);
  });

  it("writes each $ in the entry's text as $$, so the local gateway fills nothing in it", () => {
    const pkg = npm({
      identifier: "@acme/files$",
      version: "1.4.0$beta",
      packageArguments: [
        { type: "named", name: "--price$", default: "5$" },
        { type: "named", name: "--token", isSecret: true },
      ],
    });
    const launch = registryLaunch({
      source: source({ registry_type: "npm", env: ["TOKEN"], arguments: { "--token": "${TOKEN}" } }),
      entry: entry(pkg),
      digest,
    });
    expect(launch).toStrictEqual({
      ok: true,
      command: "npx",
      args: ["--yes", "@acme/files$$@1.4.0$$beta", "--price$$", "5$$", "--token", "${TOKEN}"],
      package: { name: "@acme/files$", version: "1.4.0$beta", digest, registry_type: "npm" },
    });
  });
});

describe("launch problems", () => {
  const npm = (fields: Record<string, unknown> = {}) => ({
    registryType: "npm",
    identifier: "@acme/files",
    version: "1.4.0",
    transport: stdio,
    ...fields,
  });
  const onNpm = (fields: Record<string, unknown> = {}) => source({ registry_type: "npm", ...fields });

  it("needs source.registry_type", () => {
    const cloud = registrySourceSchema.parse(catalog) as RegistrySource;
    expect(registryLaunch({ source: cloud, entry: entry(npm()), digest })).toStrictEqual({
      ok: false,
      problems: [
        { field: "source.registry_type", message: "source.registry_type picks the package the local gateway runs" },
      ],
    });
  });

  it("needs exactly one package of the type", () => {
    expect(registryLaunch({ source: onNpm(), entry: entry(), digest })).toStrictEqual({
      ok: false,
      problems: [{ field: "source.registry_type", message: "the entry lists no npm package" }],
    });
    expect(registryLaunch({ source: onNpm(), entry: entry(npm(), npm({ identifier: "@acme/other" })), digest })).toStrictEqual({
      ok: false,
      problems: [
        { field: "source.registry_type", message: "the entry lists 2 npm packages, so source.registry_type cannot pick one" },
      ],
    });
  });

  it("refuses a package that is not stdio or names another runner", () => {
    const pkg = npm({ transport: { type: "streamable-http", url: "http://localhost:8080/mcp" }, runtimeHint: "bunx" });
    expect(registryLaunch({ source: onNpm(), entry: entry(pkg), digest })).toStrictEqual({
      ok: false,
      problems: [
        {
          field: "source.registry_type",
          message: "the npm package serves streamable-http, and the local gateway runs only stdio packages",
        },
        {
          field: "source.registry_type",
          message: "the npm package runs with bunx, and the local gateway runs npm packages with npx",
        },
      ],
    });
  });

  it("needs every required environment variable in source.env", () => {
    const pkg = npm({ environmentVariables: [{ name: "API_KEY", isRequired: true }, { name: "LOG_LEVEL" }] });
    expect(registryLaunch({ source: onNpm(), entry: entry(pkg), digest })).toStrictEqual({
      ok: false,
      problems: [{ field: "source.env", message: "the npm package requires API_KEY, so source.env lists it" }],
    });
  });

  it("refuses a positional argument that source.arguments cannot key", () => {
    const pkg = npm({
      runtimeArguments: [{ type: "positional", valueHint: "root" }],
      packageArguments: [{ type: "positional" }, { type: "positional", valueHint: "root" }],
    });
    expect(registryLaunch({ source: onNpm(), entry: entry(pkg), digest })).toStrictEqual({
      ok: false,
      problems: [
        {
          field: "source.registry_type",
          message:
            "the npm package's positional argument packageArguments[0] has no valueHint, so source.arguments cannot set it",
        },
        {
          field: "source.registry_type",
          message: "the npm package has 2 arguments keyed root, so source.arguments cannot tell them apart",
        },
      ],
    });
  });

  it("refuses a key the entry fixes or does not take", () => {
    const pkg = npm({ packageArguments: [{ type: "named", name: "--mode", value: "stdio" }] });
    const set = onNpm({ arguments: { "--mode": "http", "--port": "8080" } });
    expect(registryLaunch({ source: set, entry: entry(pkg), digest })).toStrictEqual({
      ok: false,
      problems: [
        { field: "source.arguments.--mode", message: "the npm package fixes --mode, so source.arguments cannot set it" },
        { field: "source.arguments.--port", message: "the npm package takes no argument keyed --port" },
      ],
    });
  });

  it("refuses a secret whose value is not one variable", () => {
    const pkg = npm({ packageArguments: [{ type: "named", name: "--token", isSecret: true }] });
    const set = onNpm({ env: ["TOKEN"], arguments: { "--token": "Bearer ${TOKEN}" } });
    expect(registryLaunch({ source: set, entry: entry(pkg), digest })).toStrictEqual({
      ok: false,
      problems: [{ field: "source.arguments.--token", message: "--token is secret, so its value is one ${NAME} from source.env" }],
    });
  });

  it("refuses a key a fixed argument shares with a settable one", () => {
    const pkg = npm({
      packageArguments: [
        { type: "named", name: "--port", value: "8000" },
        { type: "named", name: "--port" },
      ],
    });
    expect(registryLaunch({ source: onNpm({ arguments: { "--port": "9000" } }), entry: entry(pkg), digest })).toStrictEqual({
      ok: false,
      problems: [
        {
          field: "source.registry_type",
          message: "the npm package has 2 arguments keyed --port, so source.arguments cannot tell them apart",
        },
      ],
    });
    const volumes = npm({
      packageArguments: [
        { type: "named", name: "--volume", value: "/a" },
        { type: "named", name: "--volume", value: "/b" },
      ],
    });
    const launch = registryLaunch({ source: onNpm(), entry: entry(volumes), digest });
    expect(launch.ok && launch.args).toStrictEqual(["--yes", "@acme/files@1.4.0", "--volume", "/a", "--volume", "/b"]);
  });

  it("refuses a secret whose value comes from the entry", () => {
    const key = [{ type: "named", name: "--key", default: "abc123", isSecret: true }];
    const pkg = npm({
      runtimeArguments: [{ type: "named", name: "--token", value: "hunter2", isSecret: true }],
      packageArguments: key,
    });
    expect(registryLaunch({ source: onNpm(), entry: entry(pkg), digest })).toStrictEqual({
      ok: false,
      problems: [
        {
          field: "source.registry_type",
          message: "runtimeArguments[0] is secret, and the entry fixes its value, so the lock would hold the secret in plain text",
        },
        {
          field: "source.arguments.--key",
          message:
            "packageArguments[0] is secret, so the entry's default cannot fill it. Set --key in source.arguments to one ${NAME} from source.env.",
        },
      ],
    });
    const set = onNpm({ env: ["KEY"], arguments: { "--key": "${KEY}" } });
    const launch = registryLaunch({ source: set, entry: entry(npm({ packageArguments: key })), digest });
    expect(launch.ok && launch.args).toStrictEqual(["--yes", "@acme/files@1.4.0", "--key", "${KEY}"]);
  });

  it("refuses a registry variable the local gateway would have to fill", () => {
    const variables = { variables: { region: { default: "us" } } };
    const region = [{ type: "named", name: "--region", default: "{region}", ...variables }];
    const pkg = npm({
      runtimeArguments: [{ type: "named", name: "--registry", value: "https://{region}.npm.acme.dev", ...variables }],
      packageArguments: region,
    });
    expect(registryLaunch({ source: onNpm(), entry: entry(pkg), digest })).toStrictEqual({
      ok: false,
      problems: [
        {
          field: "source.registry_type",
          message: "runtimeArguments[0] fills registry variables into its fixed value, and the local gateway fills none",
        },
        {
          field: "source.arguments.--region",
          message:
            "packageArguments[0] fills registry variables into its default, and the local gateway fills none. Set --region in source.arguments.",
        },
      ],
    });
    const set = onNpm({ arguments: { "--region": "eu" } });
    const launch = registryLaunch({ source: set, entry: entry(npm({ packageArguments: region })), digest });
    expect(launch.ok && launch.args).toStrictEqual(["--yes", "@acme/files@1.4.0", "--region", "eu"]);
  });

  it("refuses a required argument with no value", () => {
    const pkg = npm({ packageArguments: [{ type: "named", name: "--root", isRequired: true }] });
    expect(registryLaunch({ source: onNpm(), entry: entry(pkg), digest })).toStrictEqual({
      ok: false,
      problems: [
        {
          field: "source.arguments.--root",
          message: "packageArguments[0] is required, and neither source.arguments nor the entry gives it a value",
        },
      ],
    });
  });

  it("reports a required argument with no key on source.registry_type", () => {
    const pkg = npm({ packageArguments: [{ type: "positional", isRequired: true }] });
    const launch = registryLaunch({ source: onNpm(), entry: entry(pkg), digest });
    expect(launch.ok ? [] : launch.problems.map((problem) => problem.field)).toStrictEqual([
      "source.registry_type",
      "source.registry_type",
    ]);
  });
});
