// launch.test.ts: the launch a machine gets comes from the lock and
// server.toml, and nowhere else. M0's files fixture is the spec's example.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseLock,
  parseServerToml,
  registryEntrySchema,
  registryLaunch,
  type McpLockSource,
  type ServerSource,
} from "@oxagen/mcp-studio";
import { launchSpecSchema } from "@oxagen/tacho/local-servers";
import { launchSpecFor, machineGroupsOf } from "./launch";
import { FILES_DIGEST, FILES_LAUNCH } from "./test-support";

function fixture(path: string): string {
  return readFileSync(new URL(`../../../../mcp-studio/fixtures/${path}`, import.meta.url), "utf8");
}

function filesLock(): McpLockSource {
  const lock = parseLock(fixture("servers/files/tools.lock.json"));
  if (!lock.ok) throw new Error(JSON.stringify(lock.issues));
  if (lock.value.source.type !== "registry") throw new Error("the files fixture is a registry server");
  return lock.value.source;
}

function filesSource(): ServerSource {
  const server = parseServerToml(fixture("servers/files/server.toml"));
  if (!server.ok) throw new Error(JSON.stringify(server.issues));
  return server.value.source;
}

const LOCAL_PACKAGE = {
  name: "acme-files-mcp",
  version: "0.4.0",
  digest: `sha256:${"c".repeat(64)}`,
};

describe("launchSpecFor", () => {
  it("launches M0's files fixture with the lock's command, args, and package and server.toml's env", () => {
    const launch = launchSpecFor("files", filesLock(), filesSource());
    expect(launch).toEqual(FILES_LAUNCH);
    expect(launchSpecSchema.safeParse(launch).success).toBe(true);
  });

  it("matches the launch M0's registryLaunch builds from package-entry.json", () => {
    const source = filesSource();
    if (source.type !== "registry") throw new Error("the files fixture is a registry server");
    const entry = registryEntrySchema.parse(JSON.parse(fixture("registry/package-entry.json")));
    const built = registryLaunch({ source, entry, digest: FILES_DIGEST });
    if (!built.ok) throw new Error(JSON.stringify(built.problems));

    const lockSource: McpLockSource = {
      type: "registry",
      registry: source.registry,
      server: source.server,
      version: source.version,
      package: built.package,
      command: built.command,
      args: built.args,
    };
    expect(launchSpecFor("files", lockSource, source)).toEqual(FILES_LAUNCH);
  });

  it("leaves a PyPI lock's file out of the launch, which the machine's strict schema takes (ADR-233)", () => {
    const source = filesSource();
    if (source.type !== "registry") throw new Error("the files fixture is a registry server");
    const wheel = "https://files.pythonhosted.org/packages/ab/cd/acme_files-1.4.0-py3-none-any.whl";
    const lockSource: McpLockSource = {
      type: "registry",
      registry: source.registry,
      server: source.server,
      version: source.version,
      package: {
        name: "acme-files",
        version: "1.4.0",
        digest: FILES_DIGEST,
        registry_type: "pypi",
        file: { name: "acme_files-1.4.0-py3-none-any.whl", url: wheel },
      },
      command: "uvx",
      args: ["--from", wheel, "acme-files", "${WORK_DIR}"],
    };
    const launch = launchSpecFor("files", lockSource, source);
    expect(launch?.package).toStrictEqual({
      name: "acme-files",
      version: "1.4.0",
      digest: FILES_DIGEST,
      registry_type: "pypi",
    });
    expect(launchSpecSchema.safeParse(launch).success).toBe(true);
  });

  it("keeps each ${NAME} in args for the machine to fill", () => {
    expect(launchSpecFor("files", filesLock(), filesSource())?.args).toContain("${WORK_DIR}");
  });

  it("launches a local server with the lock's command and package and server.toml's args and env", () => {
    const launch = launchSpecFor(
      "acme-files",
      { type: "local", command: "/opt/acme/bin/files-mcp", package: LOCAL_PACKAGE },
      {
        type: "local",
        command: "files-mcp",
        args: ["--root", "${WORK_DIR}"],
        env: ["WORK_DIR"],
        machines: ["dev-laptops"],
      },
    );
    expect(launch).toEqual({
      server: "acme-files",
      command: "/opt/acme/bin/files-mcp",
      args: ["--root", "${WORK_DIR}"],
      env: ["WORK_DIR"],
      package: LOCAL_PACKAGE,
    });
    expect(launchSpecSchema.safeParse(launch).success).toBe(true);
  });

  it("gives a local server with no args or env empty lists", () => {
    const launch = launchSpecFor(
      "acme-files",
      { type: "local", command: "files-mcp", package: LOCAL_PACKAGE },
      { type: "local", command: "files-mcp", machines: ["dev-laptops"] },
    );
    expect(launch).toMatchObject({ args: [], env: [] });
  });

  it("gives a registry package with no env an empty env list", () => {
    const source = filesSource();
    if (source.type !== "registry") throw new Error("the files fixture is a registry server");
    const { env: _env, arguments: _arguments, ...rest } = source;
    expect(launchSpecFor("files", filesLock(), rest)?.env).toEqual([]);
  });

  it("has no launch for a registry server without machines, which the cloud gateway reaches", () => {
    const source = filesSource();
    if (source.type !== "registry") throw new Error("the files fixture is a registry server");
    const { machines: _machines, registry_type: _type, env: _env, arguments: _arguments, ...cloud } = source;
    expect(launchSpecFor("files", filesLock(), cloud)).toBeUndefined();
    expect(launchSpecFor("files", filesLock(), { ...cloud, machines: [] })).toBeUndefined();
  });

  it("has no launch for a registry lock that pins a remote, not a package", () => {
    const lock = filesLock();
    if (lock.type !== "registry") throw new Error("expected a registry lock");
    const { package: _package, command: _command, args: _args, ...rest } = lock;
    const remote: McpLockSource = { ...rest, url: "https://files.example.com/mcp", transport: "http" };
    expect(launchSpecFor("files", remote, filesSource())).toBeUndefined();
  });

  it("has no launch for a remote server", () => {
    expect(
      launchSpecFor(
        "files",
        { type: "remote", url: "https://files.example.com/mcp" },
        { type: "remote", url: "https://files.example.com/mcp", transport: "http" },
      ),
    ).toBeUndefined();
  });

  it("has no launch when the lock and server.toml disagree on the source type", () => {
    expect(
      launchSpecFor("files", { type: "local", command: "files-mcp", package: LOCAL_PACKAGE }, filesSource()),
    ).toBeUndefined();
  });
});

describe("machineGroupsOf", () => {
  it("reads source.machines for a registry package and a local server", () => {
    expect(machineGroupsOf(filesSource())).toEqual(["dev-laptops"]);
    expect(machineGroupsOf({ type: "local", command: "files-mcp", machines: ["ci-runners", "dev-laptops"] })).toEqual([
      "ci-runners",
      "dev-laptops",
    ]);
  });

  it("gives no groups to a local server that names none, so it runs nowhere", () => {
    expect(machineGroupsOf({ type: "local", command: "files-mcp" })).toEqual([]);
  });

  it("gives no groups to a server the cloud gateway reaches", () => {
    expect(machineGroupsOf({ type: "remote", url: "https://files.example.com/mcp", transport: "http" })).toEqual([]);
  });
});
