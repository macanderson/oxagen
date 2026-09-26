/**
 * The pieces under the install rig, one defect each: the receipt-taking file
 * writer, the install lock, the tolerant host.json read, the daemon's
 * write-back, and the writers' behaviour on documents of the wrong shape.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mergeCodexHooks, stripCodexHooks } from "./codex-writer";
import { HarnessFileError, HarnessFiles } from "./harness-file";
import {
  applyControlFacts,
  readHostFile,
  readHostFileLenient,
  writeHostFile,
} from "./host-file";
import { acquireInstallLock } from "./install-lock";
import { renderSystemdUnit, serviceManagerFor } from "./service";
import { stripOxagenMcpServer } from "./mcp-config-writer";
import {
  type HookInstallConfig,
  mergeTachoSettings,
  settingsShapeProblem,
  stripTachoSettings,
} from "./settings-writer";
import {
  bundleSigner,
  TEST_ENROLLMENT,
  testHostFile,
  unsignedBundle,
} from "./test-support";

const scratch = () =>
  realpathSync(mkdtempSync(join(tmpdir(), "tacho-harden-")));
const CONFIG: HookInstallConfig = {
  enrollmentId: TEST_ENROLLMENT,
  hookCommand: "/opt/tacho/tacho hook",
  port: 47001,
  localToken: "local-token-0123456789abcdef",
};

describe("HarnessFiles", () => {
  it("restores the original bytes and mode when the document says what it said", () => {
    const dir = scratch();
    const files = new HarnessFiles(join(dir, "tacho"));
    const path = join(dir, "settings.json");
    const original = '{\n\t"b": 1,\n\t"a": 2\n}';
    writeFileSync(path, original);
    chmodSync(path, 0o640);
    files.write(path, '{"a":2,"b":1,"ours":true}');
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    // The strip re-serializes with other key order and layout.
    files.write(path, '{\n  "a": 2,\n  "b": 1\n}\n');
    expect(files.settle()).toEqual([{ path, result: "restored" }]);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(lstatSync(path).mode & 0o777).toBe(0o640);
    expect(existsSync(join(dir, "tacho", "install-receipts.json"))).toBe(false);
    expect(existsSync(join(dir, "tacho", "backups"))).toBe(false);
  });

  it("restores an original whose only difference is an empty container the strip dropped", () => {
    // The strips drop an `env`, `hooks`, `mcpServers` or event list they
    // emptied. The user's own empty one looks the same by then, because the
    // merge filled it, and its absence read as an edit made while enrolled.
    const dir = scratch();
    const files = new HarnessFiles(join(dir, "tacho"));
    const path = join(dir, "settings.json");
    const original =
      '{\n    "model": "opus",\n    "env": {},\n    "hooks": { "Stop": [] },\n    "mcpServers": {}\n}\n';
    writeFileSync(path, original);
    files.write(
      path,
      '{"model":"opus","env":{"TACHO_PORT":"1"},"hooks":{"Stop":[{"ours":true}]},"mcpServers":{"oxagen":{}}}',
    );
    files.write(path, '{\n  "model": "opus"\n}\n');
    expect(files.settle()).toEqual([{ path, result: "restored" }]);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("keeps an edit that emptied a container of the user's that held something", () => {
    const dir = scratch();
    const files = new HarnessFiles(join(dir, "tacho"));
    const path = join(dir, "settings.json");
    writeFileSync(path, '{"env":{"MINE":"1"}}');
    files.write(path, '{"env":{"MINE":"1","TACHO_PORT":"1"}}');
    files.write(path, '{"env":{}}');
    expect(files.settle()[0]?.result).toBe("kept-user-edit");
    expect(readFileSync(path, "utf8")).toBe('{"env":{}}');
  });

  it("counts an empty list the strips never drop as an edit", () => {
    // `"deny": []` added while enrolled is a change the strip did not make,
    // so the original is not put back over it.
    const dir = scratch();
    const files = new HarnessFiles(join(dir, "tacho"));
    const path = join(dir, "settings.json");
    writeFileSync(path, '{"model":"opus"}');
    files.write(path, '{"model":"opus","ours":true}');
    files.write(path, '{"model":"opus","permissions":{"deny":[]}}');
    expect(files.settle()[0]?.result).toBe("kept-user-edit");
    expect(readFileSync(path, "utf8")).toBe(
      '{"model":"opus","permissions":{"deny":[]}}',
    );
  });

  it("keeps a user edit made while enrolled, and still restores the mode", () => {
    const dir = scratch();
    const files = new HarnessFiles(join(dir, "tacho"));
    const path = join(dir, "settings.json");
    writeFileSync(path, '{"a":1}');
    chmodSync(path, 0o644);
    files.write(path, '{"a":1,"ours":true}');
    files.write(path, '{"a":1,"theirs":"new"}');
    expect(files.settle()[0]?.result).toBe("kept-user-edit");
    expect(readFileSync(path, "utf8")).toBe('{"a":1,"theirs":"new"}');
    expect(lstatSync(path).mode & 0o777).toBe(0o644);
  });

  it("deletes a file and the directories it created once they are blank again", () => {
    const dir = scratch();
    const files = new HarnessFiles(join(dir, "tacho"));
    const path = join(dir, ".codex", "nested", "hooks.json");
    files.write(path, '{"hooks":{"Stop":[]}}');
    files.write(path, "{}\n");
    expect(files.settle()[0]?.result).toBe("deleted");
    expect(existsSync(join(dir, ".codex"))).toBe(false);
  });

  it("deletes a file we created that still holds only our own scaffolding", () => {
    // Cursor's hooks.json is the case this exists for. `mergeCursorHooks`
    // writes `version` because the schema demands one, and the strip removes
    // the hooks but cannot drop that key without emptying a file the user may
    // have brought. The residue is not blank, so it read as a user edit and
    // `.cursor` survived `--purge`.
    const dir = scratch();
    const files = new HarnessFiles(join(dir, "tacho"));
    const path = join(dir, ".cursor", "hooks.json");
    files.write(
      path,
      '{"version":1,"hooks":{"preToolUse":[{"command":"tacho"}]}}',
    );
    // The teardown says what it is leaving: our `version` and nothing else.
    files.write(path, '{"version":1}', true);
    expect(files.settle()[0]?.result).toBe("deleted");
    expect(existsSync(join(dir, ".cursor"))).toBe(false);
  });

  it("keeps a hook the user added to a file we created, through the strip", () => {
    // The teardown itself writes through `write`, so the stripped document —
    // the user's own hook included — becomes the bytes Tacho last wrote.
    // Matching on that alone would read their hook as our leftover and take
    // the whole file.
    const dir = scratch();
    const files = new HarnessFiles(join(dir, "tacho"));
    const path = join(dir, ".codex", "hooks.json");
    files.write(path, '{"hooks":{"Stop":[{"command":"tacho"}]}}');
    // They add one of their own while enrolled.
    writeFileSync(
      path,
      '{"hooks":{"Stop":[{"command":"tacho"},{"command":"mine"}]}}',
    );
    // Unenroll strips ours and writes what is left, which is theirs.
    files.write(path, '{"hooks":{"Stop":[{"command":"mine"}]}}');
    expect(files.settle()[0]?.result).toBe("kept-user-edit");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("mine");
  });

  it("keeps a file we created that the user has since edited", () => {
    const dir = scratch();
    const files = new HarnessFiles(join(dir, "tacho"));
    const path = join(dir, ".cursor", "hooks.json");
    files.write(
      path,
      '{"version":1,"hooks":{"preToolUse":[{"command":"tacho"}]}}',
    );
    files.write(path, '{"version":1}', true);
    // One character of theirs, after our last write, and it is theirs.
    writeFileSync(path, '{"version":1,"hooks":{"stop":[{"command":"mine"}]}}');
    expect(files.settle()[0]?.result).toBe("kept-user-edit");
    expect(existsSync(path)).toBe(true);
  });

  it("keeps a created directory the user has since put something in", () => {
    const dir = scratch();
    const files = new HarnessFiles(join(dir, "tacho"));
    const path = join(dir, ".codex", "hooks.json");
    files.write(path, '{"hooks":{}}');
    writeFileSync(join(dir, ".codex", "config.toml"), "model = 1\n");
    files.write(path, "{}");
    files.settle();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(dir, ".codex", "config.toml"))).toBe(true);
  });

  it("writes through a symlink, relative or dangling, and leaves the link", () => {
    const dir = scratch();
    const files = new HarnessFiles(join(dir, "tacho"));
    mkdirSync(join(dir, "dotfiles"));
    mkdirSync(join(dir, ".claude"));
    const link = join(dir, ".claude", "settings.json");
    symlinkSync(join("..", "dotfiles", "s.json"), link);
    files.write(link, '{"ours":true}');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(dir, "dotfiles", "s.json"), "utf8")).toBe(
      '{"ours":true}',
    );
    files.write(link, "{}");
    files.settle();
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(join(dir, "dotfiles", "s.json"))).toBe(false);
  });

  it("refuses a read-only file and a read-only directory, and names them", () => {
    const dir = scratch();
    const files = new HarnessFiles(join(dir, "tacho"));
    const path = join(dir, "settings.json");
    writeFileSync(path, "{}");
    chmodSync(path, 0o444);
    expect(files.writeProblem(path)).toContain("read-only");
    expect(() => files.write(path, "{}")).toThrow(HarnessFileError);
    expect(readFileSync(path, "utf8")).toBe("{}");
    const locked = join(dir, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o555);
    expect(files.writeProblem(join(locked, "sub", "x.json"))).toContain(locked);
    chmodSync(locked, 0o755);
  });

  it("names the file when its JSON does not parse, and reads an empty file as absent", () => {
    const dir = scratch();
    const files = new HarnessFiles(join(dir, "tacho"));
    const path = join(dir, "settings.json");
    writeFileSync(path, "{ nope");
    expect(() => files.readJson(path)).toThrow(path);
    writeFileSync(path, "  \n");
    expect(files.readJson(path)).toBeUndefined();
    expect(files.readJson(join(dir, "absent.json"))).toBeUndefined();
  });

  it("settles twice and with no receipts without touching anything", () => {
    const files = new HarnessFiles(join(scratch(), "tacho"));
    expect(files.settle()).toEqual([]);
    expect(files.settle()).toEqual([]);
  });
});

describe("the install lock", () => {
  it("refuses a second holder, frees on release, and removes what it made", () => {
    const root = join(scratch(), ".config", "oxagen", "tacho");
    const first = acquireInstallLock(root);
    expect("release" in first).toBe(true);
    expect(acquireInstallLock(root)).toEqual({ heldBy: process.pid });
    if ("release" in first) first.release();
    expect(existsSync(join(root, "..", ".."))).toBe(false);
    const again = acquireInstallLock(root);
    expect("release" in again).toBe(true);
    if ("release" in again) again.release();
  });

  it("takes over a lock whose holder died, is too old, or was cut short", () => {
    const root = scratch();
    const path = join(root, "install.lock");
    writeFileSync(path, JSON.stringify({ pid: 999_999, at: Date.now() }));
    const dead = acquireInstallLock(root, Date.now, () => false);
    expect("release" in dead).toBe(true);
    if ("release" in dead) dead.release();
    writeFileSync(path, JSON.stringify({ pid: process.pid, at: 0 }));
    const old = acquireInstallLock(root);
    expect("release" in old).toBe(true);
    if ("release" in old) old.release();
    writeFileSync(path, '{"pid":');
    const cut = acquireInstallLock(root);
    expect("release" in cut).toBe(true);
    if ("release" in cut) cut.release();
    expect(existsSync(root)).toBe(true);
  });
});

describe("host.json", () => {
  const signer = bundleSigner();
  const bundle = signer.sign(unsignedBundle());

  it("loads a file a newer tacho wrote, and carries the key it does not know", () => {
    const path = join(scratch(), "host.json");
    writeFileSync(
      path,
      JSON.stringify({ ...testHostFile(signer, bundle), gateway_port: 47002 }),
    );
    const host = readHostFile(path) as Record<string, unknown>;
    expect(host["gateway_port"]).toBe(47002);
  });

  it("salvages the enrollment id and displaced values from a file that does not validate", () => {
    const path = join(scratch(), "host.json");
    writeFileSync(
      path,
      JSON.stringify({
        host_enrollment_id: TEST_ENROLLMENT,
        displaced_env: { OTEL_LOGS_EXPORTER: "console" },
        port: "not a number",
      }),
    );
    const read = readHostFileLenient(path);
    expect(read.host).toBeUndefined();
    expect(read.error).toContain(path);
    expect(read.salvaged).toEqual({
      host_enrollment_id: TEST_ENROLLMENT,
      displaced_env: { OTEL_LOGS_EXPORTER: "console" },
      displaced_mcp_servers: {},
    });
    writeFileSync(path, "{ truncated");
    expect(readHostFileLenient(path).error).toContain("not valid JSON");
    writeFileSync(path, "[]");
    expect(readHostFileLenient(path).salvaged).toBeUndefined();
    expect(readHostFileLenient(`${path}.absent`)).toEqual({});
  });

  it("the daemon's write-back keeps what the CLI wrote since it loaded the file", () => {
    const path = join(scratch(), "host.json");
    const loaded = testHostFile(signer, bundle);
    writeHostFile(path, { ...loaded, displaced_env: { X: "1" } });
    const next = applyControlFacts(path, loaded, { host_status: "paused" });
    expect(next.host_status).toBe("paused");
    const disk = readHostFile(path);
    expect(disk?.host_status).toBe("paused");
    expect(disk?.displaced_env).toEqual({ X: "1" });
  });

  it("the daemon's write-back never resurrects a deleted host.json or overwrites another enrollment", () => {
    const path = join(scratch(), "host.json");
    const loaded = testHostFile(signer, bundle);
    applyControlFacts(path, loaded, { host_status: "paused" });
    expect(existsSync(path)).toBe(false);
    writeHostFile(path, {
      ...loaded,
      host_enrollment_id: "tch_zyxwvutsrqpnmkjhgfedcb",
      api_key: "oxk_new",
    });
    applyControlFacts(path, loaded, { host_status: "paused" });
    expect(readHostFile(path)?.api_key).toBe("oxk_new");
    expect(readHostFile(path)?.host_status).toBe("active");
  });
});

describe("the writers on the user's own values and on wrong-shaped documents", () => {
  it("gives back an env value equal to Tacho's, and a TACHO_HOME of the user's own", () => {
    const user = {
      env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1", TACHO_HOME: "/mine" },
    };
    const merged = mergeTachoSettings(user, CONFIG);
    expect(merged.displaced).toEqual(user.env);
    const stripped = stripTachoSettings(
      merged.settings,
      TEST_ENROLLMENT,
      merged.displaced,
    );
    expect(stripped.settings).toEqual(user);
    // A second merge records nothing new: those values are Tacho's now.
    expect(mergeTachoSettings(merged.settings, CONFIG).displaced).toEqual({});
  });

  it("does not restore over a value the user changed while enrolled", () => {
    const merged = mergeTachoSettings(
      { env: { OTEL_LOGS_EXPORTER: "console" } },
      CONFIG,
    );
    const edited = {
      ...merged.settings,
      env: { ...merged.settings.env, OTEL_LOGS_EXPORTER: "file" },
    };
    const stripped = stripTachoSettings(
      edited,
      TEST_ENROLLMENT,
      merged.displaced,
    );
    expect(stripped.settings.env).toEqual({ OTEL_LOGS_EXPORTER: "file" });
  });

  it("names a wrong shape and never rewrites such a document", () => {
    expect(settingsShapeProblem([])).toContain("an array");
    expect(settingsShapeProblem({ hooks: "x" })).toContain("`hooks`");
    expect(settingsShapeProblem({ hooks: { PreToolUse: {} } })).toContain(
      "hooks.PreToolUse",
    );
    expect(settingsShapeProblem({ env: [] })).toContain("`env`");
    expect(settingsShapeProblem(undefined)).toBeUndefined();
    expect(settingsShapeProblem({ hooks: { Stop: [] } })).toBeUndefined();
    for (const doc of [[], { hooks: "x" }, { hooks: { PreToolUse: {} } }]) {
      expect(stripTachoSettings(doc, TEST_ENROLLMENT)).toEqual({
        settings: doc,
        changed: false,
      });
      expect(stripCodexHooks(doc, TEST_ENROLLMENT).changed).toBe(false);
    }
    const servers = { mcpServers: ["a"] };
    expect(stripOxagenMcpServer(servers, TEST_ENROLLMENT)).toEqual({
      config: servers,
      changed: false,
    });
  });

  it("treats a group that is not an object as foreign instead of throwing", () => {
    const doc = { hooks: { PreToolUse: [null, "x"] } };
    const merged = mergeCodexHooks(doc, CONFIG);
    expect(merged.settings.hooks?.["PreToolUse"]?.slice(0, 2)).toEqual([
      null,
      "x",
    ]);
    expect(stripCodexHooks(merged.settings, TEST_ENROLLMENT).settings).toEqual(
      doc,
    );
  });
});

describe("the service managers", () => {
  const spec = {
    command: ["/opt/o x/tacho", "daemon"],
    env: { HOME: "/home/100%dev", PATH: "/usr/bin:$HOME/bin" },
    logPath: "/home/dev/tachod.log",
    workingDirectory: "/home/dev",
  };

  it("retries a launchctl bootstrap that launchd refuses once the label is gone", () => {
    const home = scratch();
    let bootstraps = 0;
    let loaded = false;
    const manager = serviceManagerFor({
      platform: "darwin",
      home,
      uid: 501,
      sleep: () => undefined,
      exec: (_command, args) => {
        if (args[0] === "bootstrap") {
          bootstraps += 1;
          // 5 is launchd's "Input/output error".
          if (bootstraps < 3)
            return { status: 5, stdout: "", stderr: "Bootstrap failed: 5" };
          loaded = true;
        }
        if (args[0] === "print")
          return loaded
            ? { status: 0, stdout: "state = running", stderr: "" }
            : { status: 113, stdout: "", stderr: "Could not find service" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    manager.install(spec);
    expect(bootstraps).toBe(3);
  });

  it("gives up after its retries and says what launchctl said", () => {
    const manager = serviceManagerFor({
      platform: "darwin",
      home: scratch(),
      uid: 501,
      sleep: () => undefined,
      exec: (_command, args) =>
        args[0] === "bootstrap"
          ? { status: 5, stdout: "", stderr: "Bootstrap failed: 5" }
          : args[0] === "print"
            ? { status: 113, stdout: "", stderr: "Could not find service" }
            : { status: 0, stdout: "", stderr: "" },
    });
    expect(() => manager.install(spec)).toThrow("Bootstrap failed: 5");
  });

  it("keeps the plist and throws when launchd still has the service after bootout", () => {
    const home = scratch();
    // Installs normally, then launchd refuses to let the label go.
    let stuck = false;
    let loaded = false;
    const manager = serviceManagerFor({
      platform: "darwin",
      home,
      uid: 501,
      sleep: () => undefined,
      exec: (_command, args) => {
        if (args[0] === "bootstrap") loaded = true;
        if (args[0] === "bootout" && !stuck) loaded = false;
        if (args[0] === "print")
          return loaded
            ? { status: 0, stdout: "state = running", stderr: "" }
            : { status: 113, stdout: "", stderr: "Could not find service" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    manager.install(spec);
    stuck = true;
    expect(() => manager.uninstall()).toThrow("still loaded");
    expect(existsSync(manager.unitPath)).toBe(true);
  });

  it("escapes % and $ in a systemd unit so a path is not read as a specifier", () => {
    const unit = renderSystemdUnit(spec);
    expect(unit).toContain('Environment="HOME=/home/100%%dev"');
    expect(unit).toContain('Environment="PATH=/usr/bin:$HOME/bin"');
    expect(unit).toContain('ExecStart="/opt/o x/tacho" "daemon"');
  });
});
