/**
 * The executable the hooks and the service name under a package manager, how
 * a harness is found on Windows and behind a chatty login shell, and the
 * files the real deps edit when the harness config directories are moved.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Exec } from "../host/service";
import { TEST_ENROLLMENT } from "../host/test-support";
import { tachoPaths } from "../host/paths";
import {
  defaultCliDeps,
  harnessFacts,
  runtimeCommands,
  stableExecutablePath,
} from "./deps";

const on =
  (...present: string[]) =>
  (candidate: string): boolean =>
    present.includes(candidate);

describe("the native tacho executable", () => {
  it("names Scoop's binary by its own name, through the current link", () => {
    const versioned =
      "C:\\Users\\dev\\scoop\\apps\\oxagen\\1.4.0\\tacho-x86_64-pc-windows-msvc.exe";
    const current =
      "C:\\Users\\dev\\scoop\\apps\\oxagen\\current\\tacho-x86_64-pc-windows-msvc.exe";
    const runtime = runtimeCommands(
      undefined,
      {},
      versioned,
      "win32",
      true,
      on(versioned, current),
    );
    expect(runtime.daemonCommand).toEqual([current, "daemon"]);
    expect(runtime.hookCommand).toBe(`"${current}" hook`);
    expect(runtime.binDir).toBe("C:\\Users\\dev\\scoop\\apps\\oxagen\\current");
    expect(runtime.executableProblem).toBeUndefined();
  });

  it("names Homebrew's opt link rather than the Cellar version brew upgrade deletes", () => {
    const cellar = "/opt/homebrew/Cellar/tacho/1.4.0/bin/tacho";
    const opt = "/opt/homebrew/opt/tacho/bin/tacho";
    const runtime = runtimeCommands(
      undefined,
      {},
      cellar,
      "darwin",
      true,
      on(cellar, opt),
    );
    expect(runtime.daemonCommand).toEqual([opt, "daemon"]);
    expect(runtime.mcpStdioCommand).toEqual([opt, "mcp-stdio"]);
    expect(runtime.binDir).toBe("/opt/homebrew/opt/tacho/bin");
    // No opt link: the path it has is the best there is.
    expect(
      runtimeCommands(undefined, {}, cellar, "darwin", true, on(cellar))
        .daemonCommand,
    ).toEqual([cellar, "daemon"]);
  });

  it("prefers a tacho in the directory over a differently named process", () => {
    const runtime = runtimeCommands(
      undefined,
      {},
      "/opt/oxagen/tacho-aarch64-apple-darwin",
      "darwin",
      true,
      on("/opt/oxagen/tacho"),
    );
    expect(runtime.daemonCommand).toEqual(["/opt/oxagen/tacho", "daemon"]);
  });

  it("says so when there is no tacho to name", () => {
    const runtime = runtimeCommands(
      undefined,
      {},
      "/opt/oxagen/oxagen-sidecar",
      "darwin",
      true,
      on(),
    );
    expect(runtime.executableProblem).toContain("/opt/oxagen");
    expect(runtime.executableProblem).toContain("oxagen-sidecar");
  });

  it("leaves a path no package manager owns alone", () => {
    expect(
      stableExecutablePath("/usr/local/bin/tacho", "darwin", () => true),
    ).toBe("/usr/local/bin/tacho");
    expect(
      stableExecutablePath(
        "C:\\Users\\dev\\scoop\\apps\\oxagen\\current\\tacho.exe",
        "win32",
        () => true,
      ),
    ).toBe("C:\\Users\\dev\\scoop\\apps\\oxagen\\current\\tacho.exe");
  });
});

describe("finding a harness", () => {
  const answering =
    (lookup: string, found: string): Exec =>
    (command, args) => {
      if (args[0] === "--version")
        return { status: 0, stdout: "codex-cli 0.104.0\n", stderr: "" };
      return command === lookup
        ? { status: 0, stdout: found, stderr: "" }
        : { status: 1, stdout: "", stderr: "" };
    };

  it("takes the batch file `where` lists after npm's extensionless shim", () => {
    const facts = harnessFacts(
      answering(
        "where",
        "C:\\npm\\codex\r\nC:\\npm\\codex.cmd\r\nC:\\npm\\codex.ps1\r\n",
      ),
      "codex",
      "win32",
      {},
      "C:\\Users\\dev",
      () => false,
    );
    expect(facts).toEqual({ path: "C:\\npm\\codex.cmd", version: "0.104.0" });
  });

  it("takes an .exe over a batch file", () => {
    expect(
      harnessFacts(
        answering("where", "C:\\npm\\codex.cmd\r\nC:\\bin\\codex.exe\r\n"),
        "codex",
        "win32",
        {},
        "C:\\Users\\dev",
        () => false,
      ).path,
    ).toBe("C:\\bin\\codex.exe");
  });

  it("reads past a login banner to the path `command -v` printed", () => {
    const env = { HOME: "/Users/dev", SHELL: "/bin/zsh" };
    expect(
      harnessFacts(
        answering(
          "/bin/zsh",
          "Now using node v22.1.0 (npm v10.7.0)\n/Users/dev/.nvm/versions/node/v22.1.0/bin/codex\n",
        ),
        "codex",
        "darwin",
        env,
        "/Users/dev",
        () => false,
      ).path,
    ).toBe("/Users/dev/.nvm/versions/node/v22.1.0/bin/codex");
    // A banner and no path is no answer, so `sh -lc` is asked next.
    const asked: string[] = [];
    const exec: Exec = (command, args) => {
      asked.push(command);
      if (args[0] === "--version")
        return { status: 0, stdout: "0.104.0\n", stderr: "" };
      if (command === "/bin/zsh")
        return { status: 0, stdout: "Welcome back\n", stderr: "" };
      if (command === "sh")
        return { status: 0, stdout: "/usr/local/bin/codex\n", stderr: "" };
      return { status: 1, stdout: "", stderr: "" };
    };
    expect(
      harnessFacts(exec, "codex", "darwin", env, "/Users/dev", () => false)
        .path,
    ).toBe("/usr/local/bin/codex");
    expect(asked.slice(0, 2)).toEqual(["/bin/zsh", "sh"]);
  });
});

describe("the real deps with moved harness directories", () => {
  function movedDeps() {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "tacho-deps-")));
    const env = {
      HOME: home,
      TACHO_HOME: join(home, "tacho"),
      CLAUDE_CONFIG_DIR: join(home, "claude-elsewhere"),
      CODEX_HOME: join(home, "codex-elsewhere"),
    };
    const deps = defaultCliDeps({
      env,
      home,
      platform: "linux",
      paths: tachoPaths(env, home, "linux"),
    });
    return { home, deps };
  }

  it("writes the base URL into the settings file the hooks went into", async () => {
    const { home, deps } = movedDeps();
    const state = await deps.modelBaseUrls?.apply({
      home,
      port: 47002,
      harnesses: ["claude-code", "codex"],
    });
    expect(state?.harnesses.map((entry) => entry.file)).toEqual([
      deps.paths.claudeSettings,
      join(home, "codex-elsewhere", "config.toml"),
    ]);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
  });

  it("takes the vendor key out of the settings file the hooks went into", async () => {
    const { home, deps } = movedDeps();
    mkdirSync(join(home, "claude-elsewhere"));
    writeFileSync(
      deps.paths.claudeSettings,
      JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-ant-FAKE-MOVED-0001" } }),
    );
    const taken = await deps.modelCredentials?.peek({
      home,
      harnesses: ["claude-code"],
    });
    expect(taken?.map((entry) => entry.credential.secret)).toEqual([
      "sk-ant-FAKE-MOVED-0001",
    ]);
  });

  it("fails the settle when a harness file still carries this host's hooks", () => {
    const { deps } = movedDeps();
    const hooked = JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: `/opt/tacho/tacho hook --enrollment ${TEST_ENROLLMENT}`,
              },
            ],
          },
        ],
      },
    });
    deps.writeSettings(JSON.parse(hooked));
    expect(() => deps.settleHarnessFiles?.()).toThrow(
      deps.paths.claudeSettings,
    );
    expect(readFileSync(deps.paths.claudeSettings, "utf8")).toContain(
      TEST_ENROLLMENT,
    );
    // The receipt survived, so the retry after a real strip deletes the file
    // enroll created.
    deps.writeSettings({});
    expect(deps.settleHarnessFiles?.()).toEqual([
      { path: deps.paths.claudeSettings, result: "deleted" },
    ]);
  });
});
