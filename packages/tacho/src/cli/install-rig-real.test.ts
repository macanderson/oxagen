/**
 * Install and uninstall against the real service manager (#4317): launchd
 * on macOS, systemd on Linux, Task Scheduler on Windows. `install-rig.test.ts`
 * proves the same round trip against fakes, which cannot show a plist launchd
 * rejects, a user manager that is missing, how `schtasks` quotes a path with
 * a space, or a daemon that outlives its uninstall.
 *
 * The files are still written under a scratch HOME and the control plane is
 * still the rig's fake. What changes is that `launchctl`, `systemctl`,
 * `schtasks`, `tasklist` and `taskkill` run for real, and the unit or task
 * starts a real process: a Node stub that writes `tachod.pid` the way
 * `tacho daemon` does and then waits.
 *
 * It runs only with TACHO_RIG_REAL_SERVICES=1, which `desktop-rig.yml` sets
 * on GitHub-hosted runners. A developer machine runs a tachod under the same
 * label, and a real `bootout` would stop it.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDaemonPid } from "../host/process-scan";
import { SCHTASKS_NAME, SERVICE_LABEL, type Exec } from "../host/service";
import type { TachoHarness } from "../wire";
import { enroll } from "./enroll";
import {
  buildRig,
  diffTrees,
  EMPTY_DIFF,
  type KillPoint,
  RigKill,
  type RigPlatform,
  seedHome,
  snapshotTree,
} from "./install-rig";
import { unenroll } from "./unenroll";

const REAL = process.env["TACHO_RIG_REAL_SERVICES"] === "1";
const platform: RigPlatform | undefined =
  process.platform === "darwin" ||
  process.platform === "linux" ||
  process.platform === "win32"
    ? process.platform
    : undefined;

/** The operating system's own command, with the runner's environment. */
const osExec: Exec = (command, args) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  return {
    status: result.error !== undefined ? null : result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr || (result.error?.message ?? ""),
  };
};

/** Every harness with a build on this platform. */
function harnesses(on: RigPlatform): TachoHarness[] {
  const all: TachoHarness[] = [
    "claude-code",
    "codex",
    "cursor",
    "stella",
    "claude-desktop",
  ];
  return on === "linux" ? all.filter((h) => h !== "claude-desktop") : all;
}

/**
 * A fresh home per case. On Linux it is the one directory the runner's
 * `~/.config/systemd/user` links to (TACHO_RIG_HOME), since the user manager
 * reads units from the real home only. On Windows its path holds a space, so
 * the task's quoting is tested too.
 */
function freshHome(label: string): string {
  const fixed = process.env["TACHO_RIG_HOME"];
  if (platform === "linux" && fixed !== undefined) {
    rmSync(fixed, { recursive: true, force: true });
    return fixed;
  }
  return platform === "win32"
    ? join(mkdtempSync(join(tmpdir(), "oxagen rig-")), `home ${label}`)
    : join(mkdtempSync(join(tmpdir(), "oxagen-rig-")), label);
}

/** The daemon the unit or task starts: it writes the pid file, then waits. */
function stubDaemon(): { command: (pidFile: string) => string[] } {
  const dir = mkdtempSync(join(tmpdir(), "oxagen-rig-daemon-"));
  const script = join(dir, "oxagen-rig-daemon.cjs");
  writeFileSync(
    script,
    [
      'const { writeFileSync } = require("node:fs");',
      "writeFileSync(",
      "  process.argv[2],",
      "  `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), exe: process.execPath })}\\n`,",
      ");",
      "setInterval(() => {}, 1 << 30);",
      "",
    ].join("\n"),
  );
  return { command: (pidFile) => [process.execPath, script, pidFile] };
}

/** Whether the real service manager holds anything of Tacho's. */
function serviceHeld(on: RigPlatform): boolean {
  if (on === "darwin") {
    const uid = process.getuid?.() ?? 0;
    return (
      osExec("launchctl", ["print", `gui/${uid}/${SERVICE_LABEL}`]).status === 0
    );
  }
  if (on === "linux") {
    const active = osExec("systemctl", [
      "--user",
      "is-active",
      "tachod.service",
    ]).stdout.trim();
    const enabled = osExec("systemctl", [
      "--user",
      "is-enabled",
      "tachod.service",
    ]).stdout.trim();
    return active === "active" || enabled === "enabled";
  }
  return osExec("schtasks", ["/Query", "/TN", SCHTASKS_NAME]).status === 0;
}

/** Whether a process with this pid is running. */
function alive(pid: number): boolean {
  if (platform === "win32")
    return osExec("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"])
      .stdout.split(/\r?\n/)
      .some((line) => line.includes(`"${pid}"`));
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(
  check: () => boolean,
  seconds: number,
  what: string,
): Promise<void> {
  for (let tick = 0; tick < seconds * 4; tick += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${what} after ${seconds} s`);
}

/**
 * What a real service manager may leave that the fakes do not, and why:
 * `systemctl --user enable` creates `default.target.wants` for its link, and
 * `disable` removes the link but not the directory.
 */
const REAL_ALLOW: Partial<Record<RigPlatform, string[]>> = {
  linux: [".config/systemd/user/default.target.wants"],
};

/** Where the service manager's own record of the run goes, for the upload. */
function record(name: string, data: unknown): void {
  const dir = process.env["TACHO_RIG_EVIDENCE"];
  if (dir === undefined) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${platform}-${name}.json`),
    `${JSON.stringify(data, null, 2)}\n`,
  );
}

/** Each platform's step after the unit or task is on disk and before it runs. */
const KILL_AFTER_WRITE: Record<RigPlatform, KillPoint> = {
  darwin: "launchctl bootstrap",
  linux: "systemctl daemon-reload",
  win32: "schtasks /Run",
};

describe.skipIf(!REAL || platform === undefined)(
  `install rig on the real service manager (${platform})`,
  () => {
    const on = platform as RigPlatform;

    it("installs, enrolls every harness, and uninstalls to the seeded home with nothing left running", async () => {
      expect(serviceHeld(on), "a tachod is already loaded here").toBe(false);
      const seed = seedHome({ platform: on, home: freshHome("round-trip") });
      const before = snapshotTree(seed.home);
      // The pid file the daemon writes, where tacho looks for it.
      const pidFile = buildRig(seed).deps.paths.pid;
      const rig = buildRig(seed, {
        realServices: {
          exec: osExec,
          daemonCommand: stubDaemon().command(pidFile),
        },
      });

      const installed = await enroll({ harnesses: harnesses(on) }, rig.deps);
      expect(installed.ok, installed.warnings.join("\n")).toBe(true);
      expect(serviceHeld(on)).toBe(true);
      await until(
        () => existsSync(pidFile),
        30,
        "the daemon wrote no pid file",
      );
      const pid = parseDaemonPid(readFileSync(pidFile, "utf8"))?.pid;
      expect(pid).toBeTypeOf("number");
      expect(alive(pid as number)).toBe(true);
      const enrolled = snapshotTree(seed.home);

      const removed = await unenroll({ purge: true }, rig.deps);
      expect(removed.ok, JSON.stringify(removed)).toBe(true);
      await until(() => !serviceHeld(on), 30, "the service is still held");
      await until(() => !alive(pid as number), 30, "the daemon still runs");
      const after = snapshotTree(seed.home);
      record("round-trip", {
        before,
        enrolled,
        after,
        execs: rig.execs,
        warnings: installed.warnings,
      });
      expect(diffTrees(before, after, REAL_ALLOW[on])).toEqual(EMPTY_DIFF);
    }, 180_000);

    it("uninstalls an install killed after the unit or task was written", async () => {
      expect(serviceHeld(on), "a tachod is already loaded here").toBe(false);
      const seed = seedHome({ platform: on, home: freshHome("killed") });
      const before = snapshotTree(seed.home);
      const daemonCommand = stubDaemon().command(buildRig(seed).deps.paths.pid);
      const killAt = KILL_AFTER_WRITE[on];
      const dying = buildRig(seed, {
        killAt,
        realServices: { exec: osExec, daemonCommand },
      });
      const outcome = await enroll(
        { harnesses: harnesses(on) },
        dying.deps,
      ).then(
        (result) => result,
        (error: unknown) => error,
      );
      if (!(outcome instanceof RigKill))
        expect((outcome as { ok: boolean }).ok).toBe(false);

      const clean = buildRig(seed, {
        realServices: { exec: osExec, daemonCommand },
      });
      const removed = await unenroll({ purge: true }, clean.deps);
      expect(removed.ok, JSON.stringify(removed)).toBe(true);
      await until(() => !serviceHeld(on), 30, "the service is still held");
      const after = snapshotTree(seed.home);
      record("killed", { killAt, before, after, execs: clean.execs });
      expect(diffTrees(before, after, REAL_ALLOW[on])).toEqual(EMPTY_DIFF);
    }, 180_000);
  },
);
