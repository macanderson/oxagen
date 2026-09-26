/**
 * The bridge against a fake of Tauri's core module: every Rust command is one
 * `invoke`, the picker calls unwrap their envelopes, and a sidecar run goes
 * through the shell's `run_sidecar`, streams lines as they arrive over its
 * channel, and settles on the exit or an error.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type SidecarMessage =
  | { event: "stdout" | "stderr" | "error"; data: string }
  | { event: "terminated"; data: { code: number | null } };

interface FakeChannel {
  onmessage: (message: SidecarMessage) => void;
}

interface FakeSidecar {
  program: string;
  args: string[];
  id: number;
  emit: (
    kind: "stdout" | "stderr" | "close" | "error",
    payload: unknown,
  ) => void;
}

const invoked: Array<{ cmd: string; args: unknown }> = [];
const answers = new Map<string, unknown>();
const spawned: FakeSidecar[] = [];
let spawnFails: Error | undefined;
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (message: SidecarMessage) => void = () => undefined;
  },
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    invoked.push({ cmd, args });
    if (cmd === "run_sidecar") {
      const channel = args?.onEvent as FakeChannel;
      const id = 1000 + spawned.length;
      spawned.push({
        program: String(args?.sidecar),
        args: args?.args as string[],
        id,
        emit: (kind, payload) =>
          channel.onmessage(
            kind === "close"
              ? {
                  event: "terminated",
                  data: payload as { code: number | null },
                }
              : { event: kind, data: String(payload) },
          ),
      });
      if (spawnFails !== undefined) throw spawnFails;
      return id;
    }
    if (!answers.has(cmd) && cmd === "set_busy")
      throw new Error("command set_busy not found");
    return answers.get(cmd);
  },
}));

import {
  apiPost,
  checkLiveSession,
  DETECT_TIMEOUT_MS,
  detectHarnesses,
  installCli,
  isUnauthorized,
  parseConnect,
  parseDetect,
  listOrganizations,
  listWorkspaces,
  logTail,
  readState,
  reportBusy,
  removeLocalData,
  runSidecar,
  tachoStatus,
  uninstallCli,
} from "./bridge";

beforeEach(() => {
  invoked.length = 0;
  answers.clear();
  spawned.length = 0;
  spawnFails = undefined;
});

describe("Rust commands", () => {
  it("maps each helper to one invoke with its arguments", async () => {
    answers.set("desktop_state", { platform: "macos" });
    answers.set("install_cli", {
      dir: "/usr/local/bin",
      files: [],
      on_path: true,
      note: "",
    });
    answers.set("uninstall_cli", ["/usr/local/bin/oxagen"]);
    answers.set("remove_local_data", {
      removed: ["/Users/dev/.config/oxagen"],
      left: [],
    });
    answers.set("log_tail", "line\n");
    expect(await readState()).toEqual({ platform: "macos" });
    expect((await installCli()).on_path).toBe(true);
    expect(await uninstallCli()).toEqual(["/usr/local/bin/oxagen"]);
    expect(await removeLocalData()).toEqual({
      removed: ["/Users/dev/.config/oxagen"],
      left: [],
    });
    expect(await logTail()).toBe("line\n");
    await logTail(40);
    expect(invoked).toEqual([
      { cmd: "desktop_state", args: undefined },
      { cmd: "install_cli", args: undefined },
      { cmd: "uninstall_cli", args: undefined },
      { cmd: "remove_local_data", args: undefined },
      { cmd: "log_tail", args: { lines: 120 } },
      { cmd: "log_tail", args: { lines: 40 } },
    ]);
  });

  it("posts the two picker calls through Rust and unwraps their envelopes", async () => {
    answers.set("api_post", {
      organizations: [{ id: "o1", slug: "acme", name: "Acme" }],
    });
    expect(await listOrganizations()).toEqual([
      { id: "o1", slug: "acme", name: "Acme" },
    ]);
    expect(invoked.at(-1)).toEqual({
      cmd: "api_post",
      args: { path: "/v1/user/organizations", body: {} },
    });
    answers.set("api_post", { workspaces: [{ slug: "core", name: "Core" }] });
    expect(await listWorkspaces("acme")).toEqual([
      { slug: "core", name: "Core" },
    ]);
    expect(invoked.at(-1)).toEqual({
      cmd: "api_post",
      args: { path: "/v1/user/workspaces", body: { orgSlug: "acme" } },
    });
    answers.set("api_post", { ok: true });
    expect(await apiPost("/v1/anything", { a: 1 })).toEqual({ ok: true });
  });
});

describe("runSidecar", () => {
  it("streams lines to the listener as they arrive and resolves with both buffers on close", async () => {
    const seen: string[] = [];
    const pending = runSidecar(
      "tacho",
      ["enroll", "--org", "acme"],
      (line, stream) => seen.push(`${stream}:${line}`),
    );
    const command = spawned[0];
    if (command === undefined) throw new Error("no sidecar spawned");
    expect(command.program).toBe("tacho");
    expect(command.args).toEqual(["enroll", "--org", "acme"]);
    // Let the invoke settle before emitting, as the real shell does.
    await Promise.resolve();
    command.emit("stdout", "[1/6] Minting the device key");
    command.emit("stderr", "warning: no claude on PATH");
    command.emit("stdout", "[2/6] Enrolling");
    expect(seen).toEqual([
      "stdout:[1/6] Minting the device key",
      "stderr:warning: no claude on PATH",
      "stdout:[2/6] Enrolling",
    ]);
    command.emit("close", { code: 0 });
    expect(await pending).toEqual({
      code: 0,
      stdout: "[1/6] Minting the device key\n[2/6] Enrolling\n",
      stderr: "warning: no claude on PATH\n",
    });
  });

  it("rejects when the process errors or the shell refuses it, as an Error either way", async () => {
    const failing = runSidecar("oxagen", ["login", "--browser"]);
    await Promise.resolve();
    spawned[0]?.emit("error", "sidecar not found");
    await expect(failing).rejects.toThrow("sidecar not found");
    spawnFails = new Error(
      "Oxagen does not run `tacho daemon`: not a command the app sends",
    );
    await expect(runSidecar("tacho", ["daemon"])).rejects.toThrow(
      "Oxagen does not run `tacho daemon`",
    );
  });

  // Audit D-12: the page named any environment the sidecar ran with. It now
  // hands over the sidecar and the argv only, and the Rust shell adds what
  // it needs (TACHO_BIN_DIR) itself.
  it("asks the Rust shell to run it and passes no environment of its own", async () => {
    const pending = runSidecar("tacho", ["unenroll", "--purge"]);
    const call = invoked.find((c) => c.cmd === "run_sidecar");
    expect(call?.args).toEqual({
      sidecar: "tacho",
      args: ["unenroll", "--purge"],
      onEvent: expect.anything(),
    });
    await Promise.resolve();
    spawned[0]?.emit("close", { code: 0 });
    await pending;
    expect(invoked.map((c) => c.cmd)).toEqual(["run_sidecar"]);
  });

  it("gives a bounded probe a deadline instead of waiting on a close that never comes", async () => {
    vi.useFakeTimers();
    try {
      const pending = runSidecar("tacho", ["detect", "--json"], undefined, {
        timeoutMs: 5_000,
      });
      await Promise.resolve();
      await Promise.resolve();
      spawned[0]?.emit("stdout", "{");
      vi.advanceTimersByTime(5_001);
      await expect(pending).rejects.toThrow(
        "tacho detect --json did not finish within 5s",
      );
      // The late process is stopped by the id the shell gave it.
      expect(invoked.at(-1)).toEqual({
        cmd: "kill_sidecar",
        args: { id: spawned[0]?.id },
      });
      // A close inside the deadline clears it and resolves normally.
      const quick = runSidecar("tacho", ["status", "--json"], undefined, {
        timeoutMs: 5_000,
      });
      await Promise.resolve();
      await Promise.resolve();
      spawned[1]?.emit("close", { code: 0 });
      expect(await quick).toEqual({ code: 0, stdout: "", stderr: "" });
      vi.advanceTimersByTime(10_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads tacho status --json off the sidecar and answers null when it printed none", async () => {
    const ok = tachoStatus();
    await Promise.resolve();
    spawned[0]?.emit(
      "stdout",
      '{"enrolled": true, "wal": {"sessions": 1, "unshipped": 0}}',
    );
    spawned[0]?.emit("close", { code: 0 });
    expect(spawned[0]?.args).toEqual(["status", "--json"]);
    expect(await ok).toEqual({
      enrolled: true,
      wal: { sessions: 1, unshipped: 0 },
    });
    // A clean run that printed nothing is null; a run that failed or wrote
    // to stderr without a document is an error the panel must show.
    const none = tachoStatus();
    await Promise.resolve();
    spawned[1]?.emit("close", { code: 0 });
    expect(await none).toBeNull();
    const failed = tachoStatus();
    await Promise.resolve();
    spawned[2]?.emit("stderr", "tacho: cannot read host.json");
    spawned[2]?.emit("close", { code: 1 });
    await expect(failed).rejects.toThrow("tacho: cannot read host.json");
    const silent = tachoStatus();
    await Promise.resolve();
    spawned[3]?.emit("close", { code: 2 });
    await expect(silent).rejects.toThrow("tacho status exited 2");
    // Not enrolled: the document is printed with exit 1 and is still read.
    const notEnrolled = tachoStatus();
    await Promise.resolve();
    spawned[4]?.emit("stdout", '{"enrolled": false}');
    spawned[4]?.emit("close", { code: 1 });
    expect(await notEnrolled).toEqual({ enrolled: false });
  });
});

describe("detect and connect parsing", () => {
  it("reads the detect document and rejects anything else", () => {
    const doc = {
      enrolled: false,
      harnesses: [
        {
          harness: "claude-code",
          label: "Claude Code",
          installed: true,
          path: "/x",
          version: "2.1.0",
          enrolled: false,
        },
        { harness: "codex", label: "Codex", installed: false, enrolled: false },
      ],
    };
    expect(parseDetect(JSON.stringify(doc))).toEqual(doc);
    expect(parseDetect("")).toBeNull();
    expect(parseDetect("not json")).toBeNull();
    expect(parseDetect(JSON.stringify({ enrolled: true }))).toBeNull();
  });

  it("takes the last JSON line of a verify run and falls back to stderr", () => {
    expect(
      parseConnect({
        code: 0,
        stdout:
          'Running claude -p...\nSession s chained as u: 6 events, sealed.\n{"ok":true,"sessionId":"s","seq":6,"detail":"chained"}\n',
        stderr: "",
      }),
    ).toEqual({ ok: true, sessionId: "s", seq: 6, detail: "chained" });
    expect(
      parseConnect({
        code: 1,
        stdout: '{"ok":false,"detail":"not enrolled"}\n',
        stderr: "",
      }),
    ).toEqual({ ok: false, detail: "not enrolled" });
    expect(
      parseConnect({ code: 1, stdout: "", stderr: "codex: not found\n" }),
    ).toEqual({
      ok: false,
      detail: "codex: not found",
    });
    expect(parseConnect({ code: null, stdout: "{broken", stderr: "" })).toEqual(
      {
        ok: false,
        detail: "tacho verify exited ? without a result",
      },
    );
  });
});

describe("the machine scan", () => {
  it("resolves the detect document", async () => {
    const pending = detectHarnesses();
    await Promise.resolve();
    expect(spawned[0]?.args).toEqual(["detect", "--json"]);
    spawned[0]?.emit("stdout", '{"enrolled":false,"harnesses":[]}');
    spawned[0]?.emit("close", { code: 0 });
    expect(await pending).toEqual({ enrolled: false, harnesses: [] });
  });

  it("fails a scan that printed no document instead of reporting nothing found", async () => {
    const withStderr = detectHarnesses();
    await Promise.resolve();
    spawned[0]?.emit("stdout", "warning: profile printed this");
    spawned[0]?.emit("stderr", "tacho: cannot read host.json");
    spawned[0]?.emit("close", { code: 1 });
    await expect(withStderr).rejects.toThrow("tacho: cannot read host.json");
    const silent = detectHarnesses();
    await Promise.resolve();
    spawned[1]?.emit("close", { code: 3 });
    await expect(silent).rejects.toThrow(
      "tacho detect exited 3 without a report",
    );
  });

  it("gives four harnesses' login-shell probes time to finish", () => {
    // Four harnesses, three probes each, 10 s apiece in tacho.
    expect(DETECT_TIMEOUT_MS).toBeGreaterThanOrEqual(4 * 3 * 10_000);
  });
});

describe("the session check before a reassign", () => {
  it("answers live when the control plane lists the organizations", async () => {
    expect(await checkLiveSession(async () => [])).toEqual({ live: true });
  });

  it("calls a 401 an expired session and says nothing was changed", async () => {
    expect(
      await checkLiveSession(async () => {
        throw new Error("401: unauthorized");
      }),
    ).toEqual({
      live: false,
      expired: true,
      message: "Sign in again first. Nothing was changed.",
    });
  });

  it("refuses when the control plane cannot be reached, without calling the session dead", async () => {
    const check = await checkLiveSession(async () => {
      throw new Error("error sending request");
    });
    expect(check.live).toBe(false);
    if (!check.live) {
      expect(check.expired).toBe(false);
      expect(check.message).toContain("error sending request");
      expect(check.message).toContain("Nothing was changed.");
    }
  });

  it("asks the organizations endpoint by default", async () => {
    answers.set("api_post", { organizations: [] });
    expect(await checkLiveSession()).toEqual({ live: true });
    expect(invoked).toEqual([
      {
        cmd: "api_post",
        args: { path: "/v1/user/organizations", body: {} },
      },
    ]);
  });

  it("reads only a leading 401 as unauthorized", () => {
    expect(isUnauthorized(new Error("401: token expired"))).toBe(true);
    expect(isUnauthorized("401")).toBe(true);
    expect(isUnauthorized(new Error("500: upstream 401"))).toBe(false);
  });
});

describe("the close guard", () => {
  it("tells the Rust shell when an action starts and ends", async () => {
    answers.set("set_busy", null);
    await reportBusy(true);
    await reportBusy(false);
    expect(invoked).toEqual([
      { cmd: "set_busy", args: { busy: true } },
      { cmd: "set_busy", args: { busy: false } },
    ]);
  });

  it("changes nothing on a shell that predates the command", async () => {
    await expect(reportBusy(true)).resolves.toBeUndefined();
  });
});
