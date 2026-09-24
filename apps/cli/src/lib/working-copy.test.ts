/**
 * The working-copy report `oxagen init` and `oxagen pull` send, and the
 * `.gitignore` line init adds. The probes run against real temp directories
 * (and a real `git init` where git matters); the API client and the config
 * directory are mocked so nothing leaves the process or touches `~/.config`.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  configDir: "",
  apiPostOrThrow: vi.fn(),
}));
vi.mock("./config.js", () => ({ getConfigDir: () => hoisted.configDir }));
vi.mock("./api.js", () => ({ apiPostOrThrow: hoisted.apiPostOrThrow }));

import {
  cliVersion,
  ensureWorkspaceLinkIgnored,
  machineId,
  oxagenPresent,
  parseRemoteRepository,
  probeWorkingCopy,
  projectRootFor,
  reportWorkingCopy,
  symlinkState,
} from "./working-copy.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-wc-test-"));
  hoisted.configDir = join(dir, "config");
  hoisted.apiPostOrThrow.mockReset();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/** A repository at `<dir>/repo` on branch `main`, with one commit. */
function makeRepo(): string {
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git(repo, "add", "README.md");
  git(repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "one");
  return repo;
}

describe("parseRemoteRepository", () => {
  it.each([
    ["https://github.com/acme/payments.git", "acme/payments"],
    ["https://github.com/acme/payments", "acme/payments"],
    ["https://github.com/acme/payments/", "acme/payments"],
    [
      "https://x-access-token:secret@github.com/acme/payments.git",
      "acme/payments",
    ],
    ["git@github.com:acme/payments.git", "acme/payments"],
    ["git@github.com:acme/payments", "acme/payments"],
    ["ssh://git@github.com/acme/payments.git", "acme/payments"],
    ["ssh://git@github.com:2222/acme/payments.git", "acme/payments"],
    ["https://gitlab.com/group/sub/name.git", "group/sub/name"],
  ])("reads %s as %s", (url, expected) => {
    expect(parseRemoteRepository(url)).toBe(expected);
  });

  it.each([
    [""],
    ["file:///srv/repos/payments.git"],
    ["/srv/repos/payments.git"],
    ["C:\\repos\\payments"],
    ["https://github.com/"],
    ["https://github.com/acme"],
    ["not a url"],
  ])("returns null for %j", (url) => {
    expect(parseRemoteRepository(url)).toBeNull();
  });

  it("never returns the credentials in the URL", () => {
    expect(
      parseRemoteRepository("https://user:hunter2@github.com/acme/payments"),
    ).not.toContain("hunter2");
  });
});

describe("symlinkState", () => {
  it("is none without a .stella/ directory", () => {
    expect(symlinkState(dir)).toBe("none");
  });

  it("is linked when all three links resolve inside .oxagen/", () => {
    for (const d of ["rules", "proposals", "agents"]) {
      mkdirSync(join(dir, ".oxagen", d), { recursive: true });
    }
    mkdirSync(join(dir, ".stella"));
    for (const d of ["rules", "proposals", "agents"]) {
      symlinkSync(join("..", ".oxagen", d), join(dir, ".stella", d));
    }
    expect(symlinkState(dir)).toBe("linked");
  });

  it("is missing when one link is absent", () => {
    mkdirSync(join(dir, ".oxagen", "rules"), { recursive: true });
    mkdirSync(join(dir, ".oxagen", "agents"), { recursive: true });
    mkdirSync(join(dir, ".stella"));
    symlinkSync(join("..", ".oxagen", "rules"), join(dir, ".stella", "rules"));
    symlinkSync(
      join("..", ".oxagen", "agents"),
      join(dir, ".stella", "agents"),
    );
    expect(symlinkState(dir)).toBe("missing");
  });

  it("is missing when a link is broken", () => {
    mkdirSync(join(dir, ".oxagen"), { recursive: true });
    mkdirSync(join(dir, ".stella"));
    for (const d of ["rules", "proposals", "agents"]) {
      symlinkSync(join("..", ".oxagen", d), join(dir, ".stella", d));
    }
    expect(symlinkState(dir)).toBe("missing");
  });

  it("is missing when a link resolves outside .oxagen/", () => {
    for (const d of ["rules", "proposals"]) {
      mkdirSync(join(dir, ".oxagen", d), { recursive: true });
    }
    mkdirSync(join(dir, "elsewhere"));
    mkdirSync(join(dir, ".stella"));
    symlinkSync(join("..", ".oxagen", "rules"), join(dir, ".stella", "rules"));
    symlinkSync(
      join("..", ".oxagen", "proposals"),
      join(dir, ".stella", "proposals"),
    );
    symlinkSync(join("..", "elsewhere"), join(dir, ".stella", "agents"));
    expect(symlinkState(dir)).toBe("missing");
  });

  it("is missing when a link is a plain directory", () => {
    mkdirSync(join(dir, ".oxagen"), { recursive: true });
    for (const d of ["rules", "proposals", "agents"]) {
      mkdirSync(join(dir, ".stella", d), { recursive: true });
    }
    expect(symlinkState(dir)).toBe("missing");
  });
});

describe("oxagenPresent", () => {
  it("is false without .oxagen/ and with only the link", () => {
    expect(oxagenPresent(dir)).toBe(false);
    mkdirSync(join(dir, ".oxagen"));
    writeFileSync(join(dir, ".oxagen", "workspace.json"), "{}");
    expect(oxagenPresent(dir)).toBe(false);
  });

  it("is true when .oxagen/ holds anything else", () => {
    mkdirSync(join(dir, ".oxagen", "rules"), { recursive: true });
    expect(oxagenPresent(dir)).toBe(true);
  });
});

describe("machineId", () => {
  it("creates a random secret once and hashes it", () => {
    const cfg = join(dir, "cfg");
    const first = machineId(cfg);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    const secret = readFileSync(join(cfg, "machine-id"), "utf8").trim();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    // The stored secret never leaves the machine as-is.
    expect(first).not.toBe(secret);
    expect(machineId(cfg)).toBe(first);
  });

  it("replaces a corrupt secret", () => {
    const cfg = join(dir, "cfg");
    mkdirSync(cfg);
    writeFileSync(join(cfg, "machine-id"), "not hex");
    const id = machineId(cfg);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(cfg, "machine-id"), "utf8").trim()).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("falls back to a stable hash when the directory cannot be written", () => {
    // A file where the directory should be: mkdir fails.
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "");
    const a = machineId(join(blocked, "cfg"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(machineId(join(blocked, "cfg"))).toBe(a);
  });

  it("defaults to the CLI's config directory", () => {
    machineId();
    expect(readFileSync(join(hoisted.configDir, "machine-id"), "utf8")).toMatch(
      /^[0-9a-f]{64}\n$/,
    );
  });
});

describe("projectRootFor and probeWorkingCopy", () => {
  it("uses the git top level from a subdirectory", async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "src", "deep"), { recursive: true });
    const root = await projectRootFor(join(repo, "src", "deep"));
    expect(root).toBe(git(repo, "rev-parse", "--show-toplevel"));
  });

  it("uses the directory itself outside a repository", async () => {
    expect(await projectRootFor(dir)).toBe(dir);
  });

  it("reads the remote, branch and head of a repository", async () => {
    const repo = makeRepo();
    git(repo, "remote", "add", "origin", "git@github.com:acme/payments.git");
    const head = git(repo, "rev-parse", "HEAD");
    const report = await probeWorkingCopy({
      root: repo,
      event: "pull",
      pulledCommit: "abc1234",
    });
    expect(report).toMatchObject({
      directory: repo,
      repository: "acme/payments",
      branch: "main",
      headCommit: head,
      oxagenPresent: false,
      symlinks: "none",
      pulledCommit: "abc1234",
      event: "pull",
      cliVersion: cliVersion(),
    });
    expect(report.machineId).toMatch(/^[0-9a-f]{64}$/);
    expect(report.hostname.length).toBeGreaterThan(0);
  });

  it("reads null for a detached head's branch", async () => {
    const repo = makeRepo();
    git(repo, "checkout", "-q", "--detach");
    const report = await probeWorkingCopy({ root: repo, event: "init" });
    expect(report.branch).toBeNull();
    expect(report.headCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reads nulls outside a repository and drops a malformed pulled commit", async () => {
    const report = await probeWorkingCopy({
      root: dir,
      event: "init",
      pulledCommit: "not-a-sha",
    });
    expect(report).toMatchObject({
      directory: dir,
      repository: null,
      branch: null,
      headCommit: null,
      pulledCommit: null,
    });
  });
});

describe("reportWorkingCopy", () => {
  it("posts the probe to working-copies under the given scope", async () => {
    hoisted.apiPostOrThrow.mockResolvedValue({
      workingCopyId: "wcp_1",
      firstSeenAt: "2026-09-24T00:00:00.000Z",
      lastSeenAt: "2026-09-24T00:00:01.000Z",
    });
    const outcome = await reportWorkingCopy({
      root: dir,
      scope: { org: "acme", ws: "payments" },
      event: "init",
    });
    expect(outcome).toEqual({
      workingCopyId: "wcp_1",
      lastSeenAt: "2026-09-24T00:00:01.000Z",
    });
    const [path, body, scope, options] =
      hoisted.apiPostOrThrow.mock.calls[0] ?? [];
    expect(path).toBe("working-copies");
    expect(body).toMatchObject({ directory: dir, event: "init" });
    expect(scope).toEqual({ org: "acme", ws: "payments" });
    expect(options).toMatchObject({ timeoutMs: expect.any(Number) });
  });

  it("returns the error instead of throwing", async () => {
    hoisted.apiPostOrThrow.mockRejectedValue(new Error("Error 404 from x"));
    const outcome = await reportWorkingCopy({
      root: dir,
      scope: { org: "acme", ws: "payments" },
      event: "pull",
    });
    expect(outcome).toEqual({ error: "Error 404 from x" });
  });
});

describe("ensureWorkspaceLinkIgnored", () => {
  it("touches nothing outside a git work tree", async () => {
    expect(await ensureWorkspaceLinkIgnored(dir)).toBeNull();
    expect(() => readFileSync(join(dir, ".gitignore"))).toThrow();
  });

  it("creates .gitignore with the link, once", async () => {
    const repo = makeRepo();
    const top = git(repo, "rev-parse", "--show-toplevel");
    const written = await ensureWorkspaceLinkIgnored(repo);
    expect(written).toBe(join(top, ".gitignore"));
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe(
      ".oxagen/workspace.json\n",
    );
    expect(await ensureWorkspaceLinkIgnored(repo)).toBeNull();
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe(
      ".oxagen/workspace.json\n",
    );
  });

  it("appends on a new line to a .gitignore without a trailing newline", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, ".gitignore"), "node_modules");
    await ensureWorkspaceLinkIgnored(repo);
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe(
      "node_modules\n.oxagen/workspace.json\n",
    );
  });

  it("leaves a .gitignore alone when a rule already covers the link", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, ".gitignore"), ".oxagen/\n");
    expect(await ensureWorkspaceLinkIgnored(repo)).toBeNull();
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe(".oxagen/\n");
  });
});
