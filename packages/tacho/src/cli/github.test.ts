import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bundleSigner,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { readHostFile, writeHostFile } from "../host/host-file";
import { buildRig, seedHome } from "./install-rig";
import {
  githubConfigure,
  githubCredential,
  restoreGithubRepositories,
} from "./github";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
function setup() {
  const seed = seedHome();
  homes.push(seed.home);
  const rig = buildRig(seed);
  const cwd = join(seed.home, "project with spaces");
  mkdirSync(cwd);
  const git = (args: string[]) =>
    spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(seed.home, "empty-global"),
      },
    });
  expect(git(["init"]).status).toBe(0);
  const signer = bundleSigner();
  writeHostFile(
    rig.deps.paths.hostFile,
    testHostFile(signer, signer.sign(unsignedBundle())),
  );
  const out = vi.fn();
  const deps = {
    ...rig.deps,
    out,
    exec: (_command: string, args: string[]) => git(args.slice(2)),
  };
  return {
    cwd,
    deps,
    git,
    out,
    options: { cwd, repository: "acme/repo", harness: "claude-code" },
  };
}

describe("GitHub transport configuration", () => {
  it("rewrites only its repository, resets helpers only for the local proxy, and restores on removal", () => {
    const t = setup();
    t.git(["config", "--local", "credential.helper", "personal-helper"]);
    t.git(["remote", "add", "origin", "git@github.com:acme/repo.git"]);
    t.git(["remote", "add", "other", "https://github.com/acme/repository.git"]);
    t.git([
      "config",
      "--local",
      "--add",
      "remote.origin.pushurl",
      "https://github.com/acme/repo.git",
    ]);
    t.git([
      "config",
      "--local",
      "--add",
      "remote.origin.pushurl",
      "git@github.com:acme/repo.git",
    ]);
    githubConfigure(t.options, t.deps);
    githubConfigure(t.options, t.deps);
    expect(t.git(["remote", "get-url", "origin"]).stdout.trim()).toBe(
      "http://127.0.0.1:47001/github/acme/repo.git",
    );
    expect(t.git(["remote", "get-url", "other"]).stdout.trim()).toBe(
      "https://github.com/acme/repository.git",
    );
    expect(t.git(["config", "--get", "credential.helper"]).stdout.trim()).toBe(
      "personal-helper",
    );
    const helper = t.git([
      "config",
      "--get-all",
      "credential.http://127.0.0.1:47001/github/acme/repo.git.helper",
    ]).stdout;
    expect(helper).toMatch(/^\n!/);
    expect(helper).toContain("github credential");
    expect(helper).toContain(t.cwd);
    expect(
      readHostFile(t.deps.paths.hostFile)?.github_repositories,
    ).toHaveLength(1);
    expect(
      restoreGithubRepositories(readHostFile(t.deps.paths.hostFile), t.deps),
    ).toEqual([]);
    expect(t.git(["remote", "get-url", "origin"]).stdout.trim()).toBe(
      "git@github.com:acme/repo.git",
    );
    expect(
      t
        .git(["config", "--get-all", "remote.origin.pushurl"])
        .stdout.trim()
        .split("\n"),
    ).toEqual([
      "https://github.com/acme/repo.git",
      "git@github.com:acme/repo.git",
    ]);
    expect(t.git(["config", "--get", "credential.helper"]).stdout.trim()).toBe(
      "personal-helper",
    );
  });
  it("preserves a replacement helper during uninstall", () => {
    const t = setup();
    t.git(["remote", "add", "origin", "https://github.com/acme/repo.git"]);
    githubConfigure(t.options, t.deps);
    t.git([
      "config",
      "--replace-all",
      "credential.http://127.0.0.1:47001/github/acme/repo.git.helper",
      "foreign-helper",
    ]);
    expect(
      restoreGithubRepositories(readHostFile(t.deps.paths.hostFile), t.deps),
    ).toHaveLength(1);
    expect(
      t
        .git([
          "config",
          "--get",
          "credential.http://127.0.0.1:47001/github/acme/repo.git.helper",
        ])
        .stdout.trim(),
    ).toBe("foreign-helper");
  });
  it("returns only a local daemon lease through Git's credential protocol", async () => {
    const t = setup();
    const daemonPost = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ token: "oxgit_local_lease" }),
    }));
    await githubCredential(
      {
        harness: "claude-code",
        cwd: t.cwd,
        operation: "get",
        input:
          "protocol=http\nhost=127.0.0.1:47001\npath=github/acme/repo.git\n\n",
      },
      { ...t.deps, daemonPost },
    );
    expect(daemonPost).toHaveBeenCalledWith("/github-lease", {
      repository: "acme/repo",
      cwd: t.cwd,
      harness: "claude-code",
    });
    expect(t.out).toHaveBeenCalledWith(
      "username=oxagen\npassword=oxgit_local_lease\n",
    );
    await expect(
      githubCredential(
        {
          harness: "claude-code",
          cwd: t.cwd,
          operation: "get",
          input: "protocol=https\nhost=github.com\npath=acme/repo.git\n",
        },
        { ...t.deps, daemonPost },
      ),
    ).rejects.toThrow("only answers");
    expect(daemonPost).toHaveBeenCalledTimes(1);
  });
  it("ignores store/erase operations and refuses a vendor token from the helper seam", async () => {
    const t = setup();
    const options = {
      harness: "claude-code",
      cwd: t.cwd,
      operation: "store",
      input: "",
    };
    await githubCredential(options, t.deps);
    expect(t.out).not.toHaveBeenCalled();
    await expect(
      githubCredential(
        {
          ...options,
          operation: "get",
          input:
            "protocol=http\nhost=127.0.0.1:47001\npath=github/acme/repo.git\n",
        },
        {
          ...t.deps,
          daemonPost: async () => ({
            status: 200,
            body: '{"token":"ghs_vendor"}',
          }),
        },
      ),
    ).rejects.toThrow("invalid GitHub run credential");
    expect(t.out).not.toHaveBeenCalled();
  });
});
