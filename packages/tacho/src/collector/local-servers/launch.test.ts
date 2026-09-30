import { describe, expect, it } from "vitest";
import { launchMismatch, missingVariable } from "./errors";
import { BASE_ENV_NAMES, launchShapeProblem, prepareLaunch, REGISTRY_RUNNERS } from "./launch";
import { NPM_DIGEST, npmLaunch } from "./test-support";
import type { LaunchSpec } from "./wire";

const IMAGE_DIGEST = `sha256:${"d".repeat(64)}`;

function ociLaunch(args: string[]): LaunchSpec {
  return {
    server: "github",
    command: "docker",
    args,
    env: ["GITHUB_TOKEN"],
    package: { name: "ghcr.io/github/github-mcp-server", version: "1.4.0", digest: IMAGE_DIGEST, registry_type: "oci" },
  };
}

describe("launchShapeProblem", () => {
  it("passes an npm launch that has the table's shape", () => {
    expect(launchShapeProblem(npmLaunch())).toBeUndefined();
  });

  it("passes a local server, which has no registry_type", () => {
    const local = npmLaunch({
      command: "/opt/tools/notes-server",
      args: ["--root", "${WORK_DIR}"],
      package: { name: "notes-server", version: "0.3.0", digest: NPM_DIGEST },
    });
    expect(launchShapeProblem(local)).toBeUndefined();
  });

  const WHEEL = "https://files.pythonhosted.org/packages/ab/cd/mcp_server_git-1.2.0-py3-none-any.whl";
  const pypiLaunch = (args: string[]) =>
    npmLaunch({
      command: "uvx",
      args,
      env: [],
      package: { name: "mcp-server-git", version: "1.2.0", digest: NPM_DIGEST, registry_type: "pypi" },
    });

  it("passes a pypi launch that installs the one pinned file with --from (ADR-233)", () => {
    expect(launchShapeProblem(pypiLaunch(["--from", WHEEL, "mcp-server-git", "--repo", "."]))).toBeUndefined();
  });

  it.each([
    ["names the version, which lets uvx pick a file", ["mcp-server-git@1.2.0"]],
    ["installs from plain http", ["--from", WHEEL.replace("https:", "http:"), "mcp-server-git"]],
    ["runs another package from the file", ["--from", WHEEL, "other-server"]],
  ])("refuses a pypi launch that %s (negative)", (_what, args) => {
    expect(launchShapeProblem(pypiLaunch(args))).toBe(
      "the args do not install the locked package mcp-server-git from one file with --from <url>",
    );
  });

  it("passes an oci launch with a -e pair for each env name and the image by digest", () => {
    const args = ["run", "--rm", "-i", "-e", "GITHUB_TOKEN", `ghcr.io/github/github-mcp-server@${IMAGE_DIGEST}`];
    expect(launchShapeProblem(ociLaunch(args))).toBeUndefined();
  });

  it("names the runner a package type needs", () => {
    expect(launchShapeProblem(npmLaunch({ command: "node" }))).toBe(
      "a npm package runs with npx, and the launch runs node",
    );
  });

  it("names the lead flags an npm launch lacks", () => {
    const args = ["@modelcontextprotocol/server-filesystem@2026.8.1"];
    expect(launchShapeProblem(npmLaunch({ args }))).toBe("a npm launch starts with --yes");
  });

  it("names the -e pairs an oci launch lacks", () => {
    const args = ["run", "--rm", "-i", `ghcr.io/github/github-mcp-server@${IMAGE_DIGEST}`];
    expect(launchShapeProblem(ociLaunch(args))).toBe("a oci launch starts with run --rm -i -e GITHUB_TOKEN");
  });

  it("names the locked package when the args run another", () => {
    const args = ["--yes", "@evil/server-filesystem@2026.8.1"];
    expect(launchShapeProblem(npmLaunch({ args }))).toBe(
      "the args do not name the locked package @modelcontextprotocol/server-filesystem@2026.8.1",
    );
  });

  it("reads the table M0 gives each registry type", () => {
    expect(REGISTRY_RUNNERS.oci).toEqual({ command: "docker", flags: ["run", "--rm", "-i"], pin: "digest" });
  });
});

describe("prepareLaunch", () => {
  it("fills each listed name and passes only the base variables and the listed ones", () => {
    const prepared = prepareLaunch(npmLaunch(), {
      PATH: "/usr/bin",
      HOME: "/Users/dev",
      WORK_DIR: "/Users/dev/notes",
      AWS_SECRET_ACCESS_KEY: "decoy-secret",
    });
    expect(prepared).toEqual({
      ok: true,
      launch: {
        server: "files",
        command: "npx",
        args: ["--yes", "@modelcontextprotocol/server-filesystem@2026.8.1", "/Users/dev/notes"],
        env: { PATH: "/usr/bin", HOME: "/Users/dev", WORK_DIR: "/Users/dev/notes" },
        package: npmLaunch().package,
      },
    });
  });

  it("passes every base variable the machine sets", () => {
    const env = Object.fromEntries(BASE_ENV_NAMES.map((name) => [name, `${name}-value`]));
    const prepared = prepareLaunch(npmLaunch({ args: ["--yes", "@modelcontextprotocol/server-filesystem@2026.8.1"], env: [] }), env);
    expect(prepared.ok && prepared.launch.env).toEqual(env);
  });

  it("writes $$ as a literal $, in an arg and in the package reference", () => {
    const spec = npmLaunch({
      args: ["--yes", "price$$tool@1.0.0", "--note=$${WORK_DIR}", "${WORK_DIR}"],
      package: { name: "price$tool", version: "1.0.0", digest: NPM_DIGEST, registry_type: "npm" },
    });
    const prepared = prepareLaunch(spec, { WORK_DIR: "/work" });
    expect(prepared.ok && prepared.launch.args).toEqual(["--yes", "price$tool@1.0.0", "--note=${WORK_DIR}", "/work"]);
  });

  it("refuses a launch without the table's shape", () => {
    expect(prepareLaunch(npmLaunch({ command: "node" }), {})).toEqual({
      ok: false,
      refusal: launchMismatch("a npm package runs with npx, and the launch runs node"),
    });
  });

  it("refuses an argument that names a variable env does not list", () => {
    const spec = npmLaunch({ args: ["--yes", "@modelcontextprotocol/server-filesystem@2026.8.1", "${HOME}"] });
    expect(prepareLaunch(spec, { HOME: "/Users/dev", WORK_DIR: "/work" })).toEqual({
      ok: false,
      refusal: launchMismatch("an argument names ${HOME}, which the launch's env does not list"),
    });
  });

  it("refuses a listed variable the machine does not set", () => {
    expect(prepareLaunch(npmLaunch(), { PATH: "/usr/bin" })).toEqual({
      ok: false,
      refusal: missingVariable("WORK_DIR"),
    });
  });
});
