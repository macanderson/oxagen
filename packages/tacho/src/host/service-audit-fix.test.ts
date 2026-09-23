/**
 * The service managers after the tachod service audit: the Windows launcher
 * restarts the daemon, the Windows pid file names the daemon's executable
 * and a reused pid is not killed, unenroll finishes on Linux without a
 * systemd user manager, the launcher survives non-ASCII paths and `%`, and
 * a launchd label disabled in Login Items is enabled before bootstrap.
 */
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
import { afterEach, describe, expect, it } from "vitest";
import { formatDaemonPid, isDaemonImage, parseDaemonPid } from "./process-scan";
import {
  type Exec,
  type ExecResult,
  renderWindowsLauncher,
  SERVICE_LABEL,
  serviceManagerFor,
  type ServiceSpec,
} from "./service";

const ok: ExecResult = { status: 0, stdout: "", stderr: "" };
const homes: string[] = [];
const scratch = () => {
  const home = mkdtempSync(join(tmpdir(), "tacho-svc-audit-"));
  homes.push(home);
  return home;
};
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

const WIN_SPEC: ServiceSpec = {
  command: ["C:\\Program Files\\Oxagen\\tacho.exe", "daemon"],
  env: { TACHO_HOME: "C:\\Users\\dev\\.config\\oxagen\\tacho" },
  logPath: "C:\\Users\\dev\\.config\\oxagen\\tacho\\tachod.log",
  workingDirectory: "C:\\Users\\dev\\.config\\oxagen\\tacho",
};
const LINUX_SPEC: ServiceSpec = {
  command: ["/opt/tacho/tacho", "daemon"],
  env: {},
  logPath: "/tmp/tachod.log",
  workingDirectory: "/tmp",
};

const lines = (launcher: string) => launcher.split("\r\n");

describe("the Windows launcher restart loop", () => {
  it("runs the daemon inside a loop that waits before each restart", () => {
    const launcher = lines(renderWindowsLauncher(WIN_SPEC, "abc123"));
    const start = launcher.indexOf(":run");
    const open = launcher.indexOf("(", start);
    const close = launcher.indexOf(")", open);
    expect(start).toBeGreaterThan(-1);
    expect(open).toBe(start + 1);
    const body = launcher.slice(open + 1, close);
    // The daemon runs, then a 5 s wait, then back to the label.
    const daemon = body.findIndex((line) =>
      line.startsWith('"C:\\Program Files\\Oxagen\\tacho.exe" "daemon" >> '),
    );
    const wait = body.findIndex((line) => line.includes('PING.EXE" -n 6 '));
    expect(daemon).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(daemon);
    expect(body[body.length - 1]).toBe("goto run");
    // Every fifth restart waits a minute: a daemon dying at startup is
    // retried at a bounded rate instead of in a tight loop.
    expect(body).toContain('set /a "TACHOD_RESTARTS=(TACHOD_RESTARTS+1) %% 5"');
    expect(body).toContain(
      'if %TACHOD_RESTARTS% equ 4 "%SystemRoot%\\System32\\PING.EXE" -n 56 127.0.0.1 >nul',
    );
  });

  it("stops looping once the file no longer carries its generation", () => {
    const launcher = lines(renderWindowsLauncher(WIN_SPEC, "abc123"));
    expect(launcher).toContain('set "TACHOD_LAUNCHER=abc123"');
    const check = launcher.findIndex((line) =>
      line.includes(
        'findstr.exe" /c:"TACHOD_LAUNCHER=%TACHOD_LAUNCHER%" "%~f0"',
      ),
    );
    expect(check).toBeGreaterThan(launcher.indexOf("("));
    // findstr answers 1 for "not found"; 2 and up (it could not run) is
    // not a reason to stop supervising.
    expect(launcher[check + 1]).toBe(
      "if errorlevel 1 if not errorlevel 2 exit",
    );
    // The check runs before the daemon starts on every pass.
    expect(
      launcher.findIndex((line) => line.includes('tacho.exe" "daemon"')),
    ).toBeGreaterThan(check + 1);
  });

  it("writes a new generation at each install and stops the daemon before rewriting the launcher", () => {
    const home = scratch();
    const launcher = join(home, "tachod.cmd");
    const pidPath = join(home, "tachod.pid");
    let running = true;
    let launcherAtKill: string | undefined;
    const exec: Exec = (command) => {
      if (command === "tasklist")
        return running
          ? { ...ok, stdout: '"tacho.exe","4242","Console","1","9 K"\r\n' }
          : { ...ok, stdout: "INFO: No tasks are running" };
      if (command === "taskkill") {
        launcherAtKill = readFileSync(launcher, "utf8");
        running = false;
      }
      return ok;
    };
    const manager = serviceManagerFor({
      platform: "win32",
      home,
      exec,
      launcherPath: launcher,
      pidPath,
    });
    manager.install(WIN_SPEC);
    const first = readFileSync(launcher, "utf8");
    writeFileSync(
      pidPath,
      formatDaemonPid({
        pid: 4242,
        started_at: "2026-09-23T00:00:00.000Z",
        exe: "C:\\Program Files\\Oxagen\\tacho.exe",
      }),
    );
    running = true;
    manager.install(WIN_SPEC);
    const second = readFileSync(launcher, "utf8");
    // The old launcher's daemon was killed while its own file was still in
    // place, and the file it then reads names another generation.
    expect(launcherAtKill).toBe(first);
    const generation = (text: string) =>
      /set "TACHOD_LAUNCHER=([0-9a-f]+)"/.exec(text)?.[1];
    expect(generation(first)).toMatch(/^[0-9a-f]{16}$/);
    expect(generation(second)).toMatch(/^[0-9a-f]{16}$/);
    expect(generation(second)).not.toBe(generation(first));
  });
});

describe("the Windows pid file", () => {
  const record = (exe: string) =>
    formatDaemonPid({ pid: 4242, started_at: "2026-09-23T00:00:00.000Z", exe });

  function windows(image: string, pidText: string) {
    const home = scratch();
    const pidPath = join(home, "tachod.pid");
    writeFileSync(pidPath, pidText);
    const calls: string[] = [];
    let alive = true;
    const manager = serviceManagerFor({
      platform: "win32",
      home,
      launcherPath: join(home, "tachod.cmd"),
      pidPath,
      exec: (command, args) => {
        calls.push([command, ...args].join(" "));
        if (command === "taskkill") alive = false;
        if (command === "tasklist")
          return alive
            ? { ...ok, stdout: `"${image}","4242","Console","1","9 K"\r\n` }
            : { ...ok, stdout: "INFO: No tasks are running" };
        return ok;
      },
    });
    return { manager, calls };
  }

  it("does not kill a process that was given the daemon's old pid", () => {
    const { manager, calls } = windows(
      "chrome.exe",
      record("C:\\Program Files\\nodejs\\node.exe"),
    );
    expect(manager.status()).toMatchObject({ running: false });
    manager.uninstall();
    expect(calls.some((call) => call.startsWith("taskkill"))).toBe(false);
  });

  it("kills the daemon when the pid still runs its executable", () => {
    const { manager, calls } = windows(
      "NODE.EXE",
      record("C:\\Program Files\\nodejs\\node.exe"),
    );
    expect(manager.status()).toMatchObject({
      running: true,
      detail: "pid 4242",
    });
    manager.uninstall();
    expect(calls).toContain("taskkill /PID 4242 /T /F");
  });

  it("still reads the plain pid an older daemon wrote, but only for a daemon image", () => {
    const older = windows("tacho.exe", "4242\n");
    expect(older.manager.status().running).toBe(true);
    older.manager.uninstall();
    expect(older.calls).toContain("taskkill /PID 4242 /T /F");
    const reused = windows("notepad.exe", "4242\n");
    expect(reused.manager.status().running).toBe(false);
    reused.manager.uninstall();
    expect(reused.calls.some((call) => call.startsWith("taskkill"))).toBe(
      false,
    );
  });

  it("parses the record, the plain pid and nothing else", () => {
    expect(parseDaemonPid("4242\n")).toEqual({ pid: 4242 });
    expect(parseDaemonPid(record("C:\\n\\node.exe"))).toEqual({
      pid: 4242,
      started_at: "2026-09-23T00:00:00.000Z",
      exe: "C:\\n\\node.exe",
    });
    for (const text of ["", "not a pid", "0", "-3", '{"pid":"42"}', "[42]"])
      expect(parseDaemonPid(text)).toBeUndefined();
    expect(isDaemonImage({ pid: 1, exe: "/usr/bin/node" }, "node")).toBe(true);
    expect(isDaemonImage({ pid: 1 }, "/opt/tacho/tacho")).toBe(true);
    expect(isDaemonImage({ pid: 1 }, "python3")).toBe(false);
  });
});

describe("Linux without a systemd user manager", () => {
  const WSL =
    "System has not been booted with systemd as init system (PID 1). Can't operate.\nFailed to connect to bus: Host is down";

  it.each([
    ["WSL without systemd", { status: 1, stdout: "", stderr: WSL }],
    [
      "a container",
      {
        status: 1,
        stdout: "",
        stderr: "Failed to connect to bus: No such file or directory",
      },
    ],
    [
      "no systemctl at all",
      { status: null, stdout: "", stderr: "spawnSync systemctl ENOENT" },
    ],
  ])("refuses to install on %s before writing the unit", (_host, answer) => {
    const home = scratch();
    const calls: string[] = [];
    const manager = serviceManagerFor({
      platform: "linux",
      home,
      exec: (command, args) => {
        calls.push([command, ...args].join(" "));
        return answer;
      },
    });
    expect(() => manager.install(LINUX_SPEC)).toThrow(
      /no systemd user manager is available/,
    );
    expect(existsSync(manager.unitPath)).toBe(false);
    expect(calls).toEqual(["systemctl --user show-environment"]);
  });

  function noBus(options: {
    pidText?: string;
    executable: (pid: number) => string | undefined;
    onKill?: (signal: NodeJS.Signals) => void;
  }) {
    const home = scratch();
    const pidPath = join(home, "tachod.pid");
    if (options.pidText !== undefined) writeFileSync(pidPath, options.pidText);
    const kills: string[] = [];
    const manager = serviceManagerFor({
      platform: "linux",
      home,
      pidPath,
      sleep: () => undefined,
      exec: () => ({ status: 1, stdout: "", stderr: WSL }),
      processes: {
        kill: (pid, signal) => {
          kills.push(`${pid}:${signal}`);
          options.onKill?.(signal);
        },
        executable: options.executable,
      },
    });
    // A unit an earlier enroll wrote before its daemon-reload failed.
    mkdirSync(join(manager.unitPath, ".."), { recursive: true });
    writeFileSync(manager.unitPath, "[Unit]\n");
    return { manager, kills };
  }

  it("stops a hand-run daemon by its pid file and removes the unit", () => {
    let alive = true;
    const { manager, kills } = noBus({
      pidText: formatDaemonPid({
        pid: 777,
        started_at: "2026-09-23T00:00:00.000Z",
        exe: "/usr/bin/node",
      }),
      executable: () => (alive ? "/usr/bin/node" : undefined),
      onKill: () => {
        alive = false;
      },
    });
    manager.uninstall();
    expect(kills).toEqual(["777:SIGTERM"]);
    expect(existsSync(manager.unitPath)).toBe(false);
    // Nothing left: a second unenroll finishes too.
    expect(() => manager.uninstall()).not.toThrow();
  });

  it("leaves a pid another program now holds alone", () => {
    const { manager, kills } = noBus({
      pidText: "777\n",
      executable: () => "/usr/bin/python3",
    });
    manager.uninstall();
    expect(kills).toEqual([]);
    expect(existsSync(manager.unitPath)).toBe(false);
  });

  it("kills a daemon that outlasts its shutdown wait, and keeps the unit when even that fails", () => {
    let killed = false;
    const stubborn = noBus({
      pidText: "777\n",
      executable: () => (killed ? undefined : "/opt/tacho/tacho"),
      onKill: (signal) => {
        if (signal === "SIGKILL") killed = true;
      },
    });
    stubborn.manager.uninstall();
    expect(stubborn.kills).toEqual(["777:SIGTERM", "777:SIGKILL"]);

    const unkillable = noBus({
      pidText: "777\n",
      executable: () => "/opt/tacho/tacho",
    });
    expect(() => unkillable.manager.uninstall()).toThrow(
      "pid 777 is still running",
    );
    expect(existsSync(unkillable.manager.unitPath)).toBe(true);
  });
});

describe("the Windows launcher text", () => {
  it("switches cmd to UTF-8 before any path and doubles every value's %", () => {
    const launcher = lines(
      renderWindowsLauncher(
        {
          command: ["C:\\Users\\José\\100%\\tacho.exe", "daemon"],
          env: {
            TACHO_HOME: "C:\\Users\\José\\.config\\oxagen\\tacho",
            PATH: "C:\\bin;%SystemRoot%\\x",
          },
          logPath: "C:\\Users\\José\\tachod.log",
          workingDirectory: "C:\\Users\\José\\.config\\oxagen\\tacho",
        },
        "abc123",
      ),
    );
    expect(launcher[0]).toBe("@echo off");
    expect(launcher[1]).toBe('"%SystemRoot%\\System32\\chcp.com" 65001 >nul');
    const firstPath = launcher.findIndex((line) => line.includes("José"));
    expect(firstPath).toBeGreaterThan(1);
    expect(launcher).toContain('set "PATH=C:\\bin;%%SystemRoot%%\\x"');
    expect(
      launcher.some((line) =>
        line.startsWith('"C:\\Users\\José\\100%%\\tacho.exe" "daemon" >> '),
      ),
    ).toBe(true);
    // The launcher's own variables are still expanded.
    expect(launcher).toContain('set "TACHOD_LAUNCHER=abc123"');
    expect(launcher.some((line) => line.includes("%TACHOD_LAUNCHER%"))).toBe(
      true,
    );
  });
});

describe("launchd with the label disabled in Login Items", () => {
  it("enables the label before bootstrap and ignores a failed enable", () => {
    const home = scratch();
    const calls: string[] = [];
    const manager = serviceManagerFor({
      platform: "darwin",
      home,
      uid: 501,
      sleep: () => undefined,
      exec: (command, args) => {
        calls.push([command, ...args].join(" "));
        return args[0] === "enable"
          ? { status: 1, stdout: "", stderr: "not permitted" }
          : ok;
      },
    });
    manager.install(LINUX_SPEC);
    const enable = calls.indexOf(`launchctl enable gui/501/${SERVICE_LABEL}`);
    expect(enable).toBeGreaterThan(-1);
    expect(enable).toBeLessThan(
      calls.findIndex((call) => call.startsWith("launchctl bootstrap")),
    );
  });

  it("names launchctl print-disabled when bootstrap still fails", () => {
    const manager = serviceManagerFor({
      platform: "darwin",
      home: scratch(),
      uid: 501,
      sleep: () => undefined,
      exec: (_command, args) =>
        args[0] === "bootstrap"
          ? { status: 5, stdout: "", stderr: "Bootstrap failed: 5" }
          : ok,
    });
    expect(() => manager.install(LINUX_SPEC)).toThrow(
      /Bootstrap failed: 5.*launchctl print-disabled gui\/501/,
    );
  });
});
