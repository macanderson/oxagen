import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Exec,
  type ExecResult,
  renderLaunchdPlist,
  renderSystemdUnit,
  renderWindowsLauncher,
  SERVICE_LABEL,
  serviceManagerFor,
  type ServiceSpec,
} from "./service";

const SPEC: ServiceSpec = {
  command: ["/usr/local/bin/node", "/opt/tacho/tachod.mjs"],
  env: { TACHO_HOME: "/home/dev/.config/oxagen/tacho", PATH: "/usr/bin" },
  logPath: "/home/dev/.config/oxagen/tacho/tachod.log",
  workingDirectory: "/home/dev/.config/oxagen/tacho",
};

function fakeExec(answers: Record<string, ExecResult> = {}): {
  exec: Exec;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    exec: (command, args) => {
      const key = `${command} ${args.join(" ")}`;
      calls.push(key);
      for (const [prefix, answer] of Object.entries(answers)) {
        if (key.startsWith(prefix)) return answer;
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  };
}

describe("service units", () => {
  it("renders a launchd plist with escaped values", () => {
    const plist = renderLaunchdPlist({
      ...SPEC,
      command: ["/a b/node", "<x>"],
    });
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
    expect(plist).toContain("<string>/a b/node</string>");
    expect(plist).toContain("<string>&lt;x&gt;</string>");
    expect(plist).toContain("<key>TACHO_HOME</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
  });

  it("renders a systemd unit with quoted exec and env", () => {
    const unit = renderSystemdUnit({ ...SPEC, env: { A: 'x"y' } });
    expect(unit).toContain(
      'ExecStart="/usr/local/bin/node" "/opt/tacho/tachod.mjs"',
    );
    expect(unit).toContain('Environment="A=x\\"y"');
    expect(unit).toContain("Restart=always");
  });
});

describe("service managers", () => {
  it("installs, reports, and removes a launchd agent through launchctl", () => {
    const home = mkdtempSync(join(tmpdir(), "tacho-svc-"));
    // launchd's own behaviour: `print` answers for a loaded label only, and
    // `bootout` unloads it. `uninstall` reads `print` to learn whether the
    // daemon is really gone, so a fake that always says "running" is a
    // service that will not unload.
    const calls: string[] = [];
    let loaded = false;
    const exec: Exec = (command, args) => {
      calls.push([command, ...args].join(" "));
      if (args[0] === "bootstrap") loaded = true;
      if (args[0] === "bootout") loaded = false;
      if (args[0] === "print")
        return loaded
          ? { status: 0, stdout: "state = running", stderr: "" }
          : { status: 113, stdout: "", stderr: "Could not find service" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const manager = serviceManagerFor({
      platform: "darwin",
      home,
      exec,
      uid: 501,
    });
    expect(manager.kind).toBe("launchd");
    manager.install(SPEC);
    expect(existsSync(manager.unitPath)).toBe(true);
    expect(readFileSync(manager.unitPath, "utf8")).toContain("tachod.mjs");
    expect(calls).toEqual([
      `launchctl bootout gui/501/${SERVICE_LABEL}`,
      `launchctl bootstrap gui/501 ${manager.unitPath}`,
    ]);
    expect(manager.status()).toMatchObject({ installed: true, running: true });
    manager.uninstall();
    expect(existsSync(manager.unitPath)).toBe(false);
    expect(manager.status().installed).toBe(false);
  });

  it("surfaces a launchctl bootstrap failure", () => {
    const home = mkdtempSync(join(tmpdir(), "tacho-svc-"));
    const { exec } = fakeExec({
      "launchctl bootstrap": {
        status: 5,
        stdout: "",
        stderr: "Input/output error",
      },
    });
    const manager = serviceManagerFor({
      platform: "darwin",
      home,
      exec,
      uid: 501,
      sleep: () => undefined,
    });
    expect(() => manager.install(SPEC)).toThrow(
      /bootstrap failed \(5\): Input\/output error/,
    );
  });

  it("installs, reports, and removes a systemd user unit", () => {
    const home = mkdtempSync(join(tmpdir(), "tacho-svc-"));
    const { exec, calls } = fakeExec({
      "systemctl --user is-active": {
        status: 0,
        stdout: "active\n",
        stderr: "",
      },
    });
    let disabled = false;
    const manager = serviceManagerFor({
      platform: "linux",
      home,
      exec: (command, args) => {
        if (args.includes("disable")) disabled = true;
        if (disabled && args.includes("is-active"))
          return { status: 3, stdout: "inactive", stderr: "" };
        return exec(command, args);
      },
    });
    expect(manager.kind).toBe("systemd");
    manager.install(SPEC);
    expect(calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now tachod.service",
      "systemctl --user restart tachod.service",
    ]);
    expect(manager.status()).toMatchObject({
      installed: true,
      running: true,
      detail: "active",
    });
    manager.uninstall();
    expect(existsSync(manager.unitPath)).toBe(false);
    const failing = serviceManagerFor({
      platform: "linux",
      home,
      exec: fakeExec({
        "systemctl --user daemon-reload": {
          status: 1,
          stdout: "",
          stderr: "no bus",
        },
      }).exec,
    });
    expect(() => failing.install(SPEC)).toThrow(/daemon-reload failed: no bus/);
    const failingEnable = serviceManagerFor({
      platform: "linux",
      home,
      exec: fakeExec({
        "systemctl --user enable": { status: 1, stdout: "", stderr: "denied" },
      }).exec,
    });
    expect(() => failingEnable.install(SPEC)).toThrow(/enable failed: denied/);
  });

  it("retains an existing unit when disable fails even if runtime state is unknown", () => {
    const home = mkdtempSync(join(tmpdir(), "tacho-svc-"));
    const manager = serviceManagerFor({
      platform: "linux",
      home,
      exec: fakeExec({
        "systemctl --user disable": {
          status: 1,
          stdout: "",
          stderr: "permission denied",
        },
        "systemctl --user is-active": {
          status: 4,
          stdout: "unknown",
          stderr: "",
        },
      }).exec,
    });
    manager.install(SPEC);
    const unit = readFileSync(manager.unitPath, "utf8");
    expect(() => manager.uninstall()).toThrow("permission denied");
    expect(readFileSync(manager.unitPath, "utf8")).toBe(unit);
  });

  it("restores the unit after a failed reload and permits a successful retry", () => {
    const home = mkdtempSync(join(tmpdir(), "tacho-svc-"));
    let failReload = false;
    const manager = serviceManagerFor({
      platform: "linux",
      home,
      exec: (_command, args) => {
        if (args.includes("is-active"))
          return { status: 3, stdout: "inactive", stderr: "" };
        if (args.includes("daemon-reload") && failReload)
          return { status: 1, stdout: "", stderr: "no bus" };
        if (args.includes("disable") && !existsSync(manager.unitPath))
          return { status: 1, stdout: "", stderr: "not found" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    manager.install(SPEC);
    const unit = readFileSync(manager.unitPath, "utf8");
    failReload = true;
    expect(() => manager.uninstall()).toThrow("daemon-reload failed");
    expect(readFileSync(manager.unitPath, "utf8")).toBe(unit);
    failReload = false;
    manager.uninstall();
    expect(existsSync(manager.unitPath)).toBe(false);
    expect(() => manager.uninstall()).not.toThrow();
  });

  it("reports Windows process inspection failures but keeps uninstall strict", () => {
    const home = mkdtempSync(join(tmpdir(), "tacho-svc-"));
    writeFileSync(join(home, "tachod.pid"), "42");
    const manager = serviceManagerFor({
      platform: "win32",
      home,
      exec: fakeExec({
        tasklist: { status: 1, stdout: "", stderr: "access denied" },
      }).exec,
    });
    expect(manager.status()).toEqual({
      installed: true,
      running: false,
      detail: "Cannot inspect daemon pid 42: access denied",
    });
    expect(() => manager.uninstall()).toThrow("Cannot inspect daemon pid 42");
  });

  it("refuses to install on an unsupported platform", () => {
    const manager = serviceManagerFor({
      platform: "freebsd",
      home: "/",
      exec: fakeExec().exec,
    });
    expect(manager.kind).toBe("none");
    expect(() => manager.install(SPEC)).toThrow(/no user service manager/);
    expect(manager.status().running).toBe(false);
    manager.uninstall();
  });

  it("renders a Windows launcher that sets the env and appends to the log", () => {
    const launcher = renderWindowsLauncher({
      ...SPEC,
      command: ["C:\\Program Files\\Oxagen\\tachod.exe"],
      logPath: "C:\\Users\\dev\\.config\\oxagen\\tacho\\tachod.log",
      workingDirectory: "C:\\Users\\dev\\.config\\oxagen\\tacho",
    });
    expect(launcher.startsWith("@echo off\r\n")).toBe(true);
    expect(launcher).toContain(
      'set "TACHO_HOME=/home/dev/.config/oxagen/tacho"',
    );
    expect(launcher).toContain(
      '"C:\\Program Files\\Oxagen\\tachod.exe" >> "C:\\Users\\dev\\.config\\oxagen\\tacho\\tachod.log" 2>&1',
    );
    expect(launcher).toContain(
      'cd /d "C:\\Users\\dev\\.config\\oxagen\\tacho"',
    );
  });

  it("installs a per-user Task Scheduler task on Windows, and stops and observes the daemon by pid", () => {
    const home = mkdtempSync(join(tmpdir(), "tacho-win-"));
    const launcher = join(home, "tacho", "tachod.cmd");
    const pidPath = join(home, "tacho", "tachod.pid");
    // The task's own status is "Ready" whatever the daemon does (its action
    // is `cmd /c start`, which returns at once); only the pid file says.
    const fake = fakeExec({
      "schtasks /Query": {
        status: 0,
        stdout: "TaskName: \\OxagenTachod\r\nStatus: Ready\r\n",
        stderr: "",
      },
      "tasklist /FI PID eq 4242": {
        status: 0,
        stdout: '"tacho.exe","4242","Console","1","12,345 K"\r\n',
        stderr: "",
      },
      "tasklist /FI PID eq 9": {
        status: 0,
        stdout:
          "INFO: No tasks are running which match the specified criteria.\r\n",
        stderr: "",
      },
    });
    let justKilled = false;
    const manager = serviceManagerFor({
      platform: "win32",
      home,
      exec: (command, args) => {
        if (command === "taskkill") justKilled = true;
        else if (command === "tasklist" && justKilled) {
          justKilled = false;
          return { status: 0, stdout: "No tasks", stderr: "" };
        }
        return fake.exec(command, args);
      },
      launcherPath: launcher,
      pidPath,
    });
    expect(manager.kind).toBe("schtasks");
    manager.install(SPEC);
    expect(existsSync(launcher)).toBe(true);
    expect(readFileSync(launcher, "utf8")).toContain("@echo off");
    expect(fake.calls).toContainEqual(
      expect.stringMatching(
        /^schtasks \/Create \/TN OxagenTachod \/SC ONLOGON \/RL LIMITED \/F \/TR cmd \/c start \/min "" "/,
      ),
    );
    expect(fake.calls).toContain("schtasks /Run /TN OxagenTachod");
    // No pid file yet: installed, not running, and nothing was killed.
    expect(manager.status()).toEqual({
      installed: true,
      running: false,
      detail: "no daemon process",
    });
    expect(fake.calls.filter((c) => c.startsWith("taskkill"))).toEqual([]);

    // The daemon wrote its pid: running, by that pid — and a re-install
    // (re-enroll, reassign) kills it before /Run so the reused port is free.
    writeFileSync(pidPath, "4242\n");
    expect(manager.status()).toEqual({
      installed: true,
      running: true,
      detail: "pid 4242",
    });
    fake.calls.length = 0;
    manager.install(SPEC);
    expect(fake.calls.indexOf("taskkill /PID 4242 /T /F")).toBeGreaterThan(-1);
    expect(fake.calls.indexOf("taskkill /PID 4242 /T /F")).toBeLessThan(
      fake.calls.indexOf("schtasks /Run /TN OxagenTachod"),
    );
    // A stale pid file (the process is gone) reads as stopped.
    writeFileSync(pidPath, "9\n");
    expect(manager.status().running).toBe(false);
    writeFileSync(pidPath, "not a pid\n");
    expect(manager.status().running).toBe(false);

    writeFileSync(pidPath, "4242\n");
    fake.calls.length = 0;
    manager.uninstall();
    expect(existsSync(launcher)).toBe(false);
    expect(fake.calls).toContain("schtasks /End /TN OxagenTachod");
    expect(fake.calls).toContain("taskkill /PID 4242 /T /F");
    expect(fake.calls).toContain("schtasks /Delete /TN OxagenTachod /F");
    // Nothing is killed by image name: the daemon is tacho.exe or node.exe.
    expect(fake.calls.some((c) => c.includes("/IM"))).toBe(false);

    const failing = serviceManagerFor({
      platform: "win32",
      home,
      exec: fakeExec({
        "schtasks /Create": { status: 1, stdout: "", stderr: "ERROR: Access" },
      }).exec,
      launcherPath: launcher,
    });
    expect(() => failing.install(SPEC)).toThrow(/Create failed.*Access/);
    // A task that registers but will not start is reported, not swallowed:
    // the operator sees why the collector is not up.
    const stuck = serviceManagerFor({
      platform: "win32",
      home,
      exec: fakeExec({
        "schtasks /Run": { status: 1, stdout: "", stderr: "ERROR: Disabled" },
      }).exec,
      launcherPath: launcher,
    });
    expect(() => stuck.install(SPEC)).toThrow(
      /Run failed \(1\): ERROR: Disabled/,
    );
    const absent = serviceManagerFor({
      platform: "win32",
      home,
      exec: fakeExec({
        "schtasks /Query": { status: 1, stdout: "", stderr: "not found" },
      }).exec,
      launcherPath: launcher,
    });
    expect(absent.status().installed).toBe(false);
  });
});
