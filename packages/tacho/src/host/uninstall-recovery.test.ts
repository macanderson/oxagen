import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const faults = vi.hoisted(() => ({ renameTarget: "" }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      if (to === faults.renameTarget)
        throw new Error("injected rename failure");
      return fs.renameSync(from, to);
    },
  };
});

import { enroll } from "../cli/enroll";
import { buildRig, seedHome } from "../cli/install-rig";
import { unenroll } from "../cli/unenroll";
import { HarnessFiles } from "./harness-file";
import { applyModelBaseUrls, restoreModelBaseUrls } from "./model-base-url";
import {
  type Exec,
  type ExecResult,
  renderSystemdUnit,
  serviceManagerFor,
  type ServiceSpec,
} from "./service";

const homes: string[] = [];
const scratch = () => {
  const home = mkdtempSync(join(tmpdir(), "tacho-recovery-"));
  homes.push(home);
  return home;
};
const ok: ExecResult = { status: 0, stdout: "", stderr: "" };
const spec = (home: string): ServiceSpec => ({
  command: ["/opt/tacho", "daemon"],
  env: {},
  logPath: join(home, "log"),
  workingDirectory: home,
});
afterEach(() => {
  faults.renameTarget = "";
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe("uninstall recovery", () => {
  it.each(["claude-code", "codex"] as const)(
    "retains the %s displaced value after an edited config fails to restore",
    async (harness) => {
      const home = scratch();
      const path = join(
        home,
        harness === "codex" ? ".codex/config.toml" : ".claude/settings.json",
      );
      mkdirSync(dirname(path), { recursive: true });
      const original =
        harness === "codex"
          ? 'openai_base_url = "https://original.example"\n'
          : '{"env":{"ANTHROPIC_BASE_URL":"https://original.example"}}';
      writeFileSync(path, original);
      const options = { home, port: 4319, harnesses: [harness] };
      const internals = { managedSettingsFile: join(home, "absent") };
      const applied = await applyModelBaseUrls(options, internals);
      const entry = applied.harnesses[0];
      if (!entry) throw new Error("missing harness result");
      if (harness === "codex")
        writeFileSync(path, `${readFileSync(path, "utf8")}# keep my edit\n`);
      else {
        const edited = JSON.parse(readFileSync(path, "utf8"));
        edited.theme = "mine";
        writeFileSync(path, JSON.stringify(edited));
      }
      const edited = readFileSync(path, "utf8");
      faults.renameTarget = path;
      await expect(restoreModelBaseUrls(options, internals)).rejects.toThrow(
        "injected rename failure",
      );
      expect(readFileSync(path, "utf8")).toBe(edited);
      expect(existsSync(entry.backup)).toBe(true);
      faults.renameTarget = "";
      await restoreModelBaseUrls(options, internals);
      expect(readFileSync(path, "utf8")).toContain("https://original.example");
      expect(readFileSync(path, "utf8")).not.toContain("127.0.0.1");
      expect(existsSync(entry.backup)).toBe(false);
    },
  );

  it("retains harness receipts and backups when reading a file fails", () => {
    const home = scratch();
    const root = join(home, "tacho");
    const path = join(home, "settings.json");
    const original = '{\n\t"theme": "mine"\n}\n';
    writeFileSync(path, original);
    const files = new HarnessFiles(root);
    files.write(path, '{"theme":"mine","ours":true}');
    rmSync(path);
    mkdirSync(path);
    expect(() => files.settle()).toThrow();
    expect(existsSync(join(root, "install-receipts.json"))).toBe(true);
    rmSync(path, { recursive: true });
    writeFileSync(path, '{"theme":"mine"}');
    expect(files.settle()[0]?.result).toBe("restored");
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("keeps the enrollment and running gateway when a base URL cannot be removed", async () => {
    const seed = seedHome();
    homes.push(seed.home);
    const rig = buildRig(seed);
    expect(
      (await enroll({ harnesses: ["claude-code", "codex"] }, rig.deps)).ok,
    ).toBe(true);
    const hooks = readFileSync(rig.deps.paths.claudeSettings, "utf8");
    const urls = rig.deps.modelBaseUrls;
    if (!urls) throw new Error("missing model URL writer");
    const restore = urls.restore;
    urls.restore = async () => {
      throw new Error("config is locked");
    };
    expect((await unenroll({ purge: true }, rig.deps)).ok).toBe(false);
    expect(rig.serviceLoaded()).toBe(true);
    expect(readFileSync(rig.deps.paths.claudeSettings, "utf8")).toBe(hooks);
    expect(existsSync(rig.deps.paths.hostFile)).toBe(true);
    expect(
      rig.requests.some((request) => request.url.endsWith("/revoke")),
    ).toBe(false);
    urls.restore = restore;
    expect((await unenroll({ purge: true }, rig.deps)).ok).toBe(true);
  });

  it("keeps credentials for retry when the service cannot stop", async () => {
    const seed = seedHome();
    homes.push(seed.home);
    const rig = buildRig(seed);
    expect((await enroll({ harnesses: ["codex"] }, rig.deps)).ok).toBe(true);
    const remove = rig.deps.serviceManager.uninstall;
    rig.deps.serviceManager.uninstall = () => {
      throw new Error("service is still running");
    };
    expect((await unenroll({ purge: true }, rig.deps)).ok).toBe(false);
    expect(existsSync(rig.deps.paths.hostFile)).toBe(true);
    expect(existsSync(rig.deps.paths.deviceKey)).toBe(true);
    expect(
      rig.requests.some((request) => request.url.endsWith("/revoke")),
    ).toBe(false);
    rig.deps.serviceManager.uninstall = remove;
    expect((await unenroll({ purge: true }, rig.deps)).ok).toBe(true);
  });
});

describe("service removal failures", () => {
  it.each([
    { status: 0, stdout: "active", stderr: "" },
    { status: null, stdout: "", stderr: "no bus" },
    { status: 3, stdout: "inactive", stderr: "" },
    { status: 3, stdout: "deactivating", stderr: "" },
  ])(
    "keeps the Linux unit when disable failed and state is $stdout",
    (active) => {
      const home = scratch();
      const exec: Exec = (_command, args) =>
        args.includes("disable")
          ? { status: 1, stdout: "", stderr: "denied" }
          : args.includes("is-active")
            ? active
            : ok;
      const manager = serviceManagerFor({ platform: "linux", home, exec });
      manager.install(spec(home));
      const bytes = readFileSync(manager.unitPath);
      expect(() => manager.uninstall()).toThrow("could not remove");
      expect(readFileSync(manager.unitPath)).toEqual(bytes);
    },
  );

  it("removes a partial Linux installation whose unit was never loaded", () => {
    const home = scratch();
    const exec: Exec = (_command, args) =>
      args.includes("disable")
        ? { status: 1, stdout: "", stderr: "missing unit" }
        : args.includes("is-active")
          ? { status: 4, stdout: "unknown", stderr: "" }
          : ok;
    const manager = serviceManagerFor({ platform: "linux", home, exec });
    manager.uninstall();
    manager.uninstall();
    expect(existsSync(manager.unitPath)).toBe(false);
  });

  it("reports a Linux restart failure instead of claiming installation succeeded", () => {
    const home = scratch();
    const manager = serviceManagerFor({
      platform: "linux",
      home,
      exec: (_command, args) =>
        args.includes("restart")
          ? { status: 1, stdout: "", stderr: "restart denied" }
          : ok,
    });
    expect(() => manager.install(spec(home))).toThrow("restart failed");
    expect(existsSync(manager.unitPath)).toBe(true);
  });

  it.each(["kill", "kill-still-live", "delete", "probe"])(
    "keeps the Windows launcher when %s fails",
    (failure) => {
      const home = scratch();
      const launcher = join(home, "tachod.cmd");
      const pidPath = join(home, "tachod.pid");
      let installed = false;
      const exec: Exec = (command, args) => {
        if (command === "tasklist")
          return failure === "probe"
            ? { status: 1, stdout: "", stderr: "process query denied" }
            : { ...ok, stdout: '"tacho.exe","4242"' };
        if (command === "taskkill" && failure === "kill-still-live") return ok;
        if (command === "taskkill")
          return { status: 1, stdout: "", stderr: "access denied" };
        if (installed && args.includes("/Delete"))
          return { status: 1, stdout: "", stderr: "access denied" };
        return ok;
      };
      const manager = serviceManagerFor({
        platform: "win32",
        home,
        launcherPath: launcher,
        pidPath,
        exec,
      });
      manager.install(spec(home));
      installed = true;
      if (failure !== "delete") writeFileSync(pidPath, "4242");
      const bytes = readFileSync(launcher);
      expect(() => manager.uninstall()).toThrow();
      expect(readFileSync(launcher)).toEqual(bytes);
    },
  );
});

describe("service rendering and retry", () => {
  it("preserves literal dollars in environment values and escapes command expansion", () => {
    const unit = renderSystemdUnit({
      ...spec("/tmp"),
      command: ["/opt/$name/tacho"],
      env: { PATH: "/opt/$name/bin", HOME: "/home/100%dev" },
    });
    expect(unit).toContain('Environment="PATH=/opt/$name/bin"');
    expect(unit).toContain('Environment="HOME=/home/100%%dev"');
    expect(unit).toContain('ExecStart="/opt/$$name/tacho"');
  });
  it("allows repeated Windows removal when the task and process are absent", () => {
    const home = scratch();
    const manager = serviceManagerFor({
      platform: "win32",
      home,
      launcherPath: join(home, "tachod.cmd"),
      pidPath: join(home, "tachod.pid"),
      exec: (command) =>
        command === "schtasks"
          ? {
              status: 1,
              stdout: "",
              stderr: "The system cannot find the file specified.",
            }
          : ok,
    });
    manager.uninstall();
    manager.uninstall();
    expect(existsSync(manager.unitPath)).toBe(false);
  });
});
