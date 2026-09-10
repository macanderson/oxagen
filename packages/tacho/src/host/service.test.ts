import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Exec,
  type ExecResult,
  renderLaunchdPlist,
  renderSystemdUnit,
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
    const { exec, calls } = fakeExec({
      "launchctl print": { status: 0, stdout: "state = running", stderr: "" },
    });
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
    const manager = serviceManagerFor({ platform: "linux", home, exec });
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

  it("refuses to install on an unsupported platform", () => {
    const manager = serviceManagerFor({
      platform: "win32",
      home: "/",
      exec: fakeExec().exec,
    });
    expect(manager.kind).toBe("none");
    expect(() => manager.install(SPEC)).toThrow(/no user service manager/);
    expect(manager.status().running).toBe(false);
    manager.uninstall();
  });
});
