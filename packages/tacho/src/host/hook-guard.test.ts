/**
 * The hook command that answers for a collector that is not installed
 * (ADR-230, #4298). The shell cases run the command the writers produce
 * through real shells, with the executable there and with it gone, because
 * the property is about what a harness's shell does with the string.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { shellQuote } from "../cli/deps";
import {
  collectorExecutable,
  posixWords,
  skipWhenCollectorAbsent,
} from "./hook-guard";

describe("reading a hook command", () => {
  it("splits what shellQuote writes into the words a shell reads", () => {
    expect(posixWords("/opt/tacho/tacho hook")).toEqual([
      { raw: "/opt/tacho/tacho", value: "/opt/tacho/tacho" },
      { raw: "hook", value: "hook" },
    ]);
    const quoted = shellQuote("/Users/Jo O'Brien/tacho", "darwin");
    expect(posixWords(`${quoted} hook`)).toEqual([
      { raw: quoted, value: "/Users/Jo O'Brien/tacho" },
      { raw: "hook", value: "hook" },
    ]);
  });

  it("reads nothing it cannot be sure a shell reads the same way", () => {
    for (const line of [
      '"C:\\Program Files\\Oxagen\\tacho.exe" hook',
      "/opt/$HOME/tacho hook",
      "/opt/tacho hook; rm -rf /",
      "'/opt/unterminated hook",
      "/opt/tacho\\",
      "`tacho` hook",
    ])
      expect(posixWords(line), line).toBeUndefined();
  });

  it("names the collector's own executable, in either layout", () => {
    expect(collectorExecutable("'/a b/tacho' hook")?.value).toBe("/a b/tacho");
    expect(
      collectorExecutable("/usr/bin/node /opt/tacho/tacho-hook.mjs")?.value,
    ).toBe("/opt/tacho/tacho-hook.mjs");
    // A PATH lookup, and a Windows path: nothing to test for.
    expect(collectorExecutable("tacho hook")).toBeUndefined();
    expect(
      collectorExecutable('"C:\\Program Files\\Oxagen\\tacho.exe" hook'),
    ).toBeUndefined();
  });
});

describe("wrapping a hook command", () => {
  const hook = "'/a b/tacho' hook";
  const command = `${hook} --enrollment tch_abcdefghijklmnopqrstuv --harness cursor`;

  it("tests for the executable, answers, and otherwise runs the command", () => {
    expect(
      skipWhenCollectorAbsent(hook, command, '{"permission":"allow"}'),
    ).toBe(
      `test ! -e '/a b/tacho' && printf '%s\\n' '{"permission":"allow"}' && exit 0; exec ${command}`,
    );
    expect(skipWhenCollectorAbsent(hook, command, "")).toBe(
      `test ! -e '/a b/tacho' && exit 0; exec ${command}`,
    );
  });

  it("leaves a command it cannot wrap as it is", () => {
    const windows = '"C:\\Oxagen\\tacho.exe" hook';
    expect(
      skipWhenCollectorAbsent(windows, `${windows} --harness cursor`, "{}"),
    ).toBe(`${windows} --harness cursor`);
    expect(skipWhenCollectorAbsent("tacho hook", "tacho hook x", "{}")).toBe(
      "tacho hook x",
    );
    // An answer a fish shell would read differently.
    expect(skipWhenCollectorAbsent(hook, command, "it's")).toBe(command);
    // A command that does not run the hook command.
    expect(skipWhenCollectorAbsent(hook, "other", "{}")).toBe("other");
  });
});

/**
 * The shells a harness on macOS or Linux runs a hook command with, those of
 * them this machine has. `/bin/sh` stands in on a machine with none, where
 * the cases below are skipped anyway.
 */
const FOUND_SHELLS = [
  "/bin/sh",
  "/bin/bash",
  "/bin/zsh",
  "/usr/bin/fish",
  "/opt/homebrew/bin/fish",
].filter((shell) => existsSync(shell));
const SHELLS = FOUND_SHELLS.length > 0 ? FOUND_SHELLS : ["/bin/sh"];

describe.skipIf(process.platform === "win32")(
  "the wrapped command in a real shell",
  () => {
    function scratch(): { dir: string; tacho: string } {
      const root = mkdtempSync(join(tmpdir(), "tacho-guard-"));
      const dir = join(root, "Application Support", "oxagen", "bin", "2.1.3");
      mkdirSync(dir, { recursive: true });
      return { dir, tacho: join(dir, "tacho") };
    }

    function stub(path: string, body: string): void {
      writeFileSync(path, `#!/bin/sh\ncat >/dev/null\n${body}\n`);
      chmodSync(path, 0o755);
    }

    function run(shell: string, line: string) {
      return spawnSync(shell, ["-c", line], {
        input: '{"hook_event_name":"preToolUse"}',
        encoding: "utf8",
        timeout: 10_000,
      });
    }

    it.each(SHELLS)(
      "%s answers an allow and exits 0 when the collector is gone",
      (shell) => {
        const { tacho } = scratch();
        const hook = `${shellQuote(tacho, "darwin")} hook`;
        const allow = '{"permission":"allow"}';
        const line = skipWhenCollectorAbsent(
          hook,
          `${hook} --enrollment tch_abcdefghijklmnopqrstuv --harness cursor`,
          allow,
        );
        const result = run(shell, line);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe(`${allow}\n`);
        // Stella's form prints nothing at all.
        const quiet = run(
          shell,
          skipWhenCollectorAbsent(hook, `${hook} --harness stella`, ""),
        );
        expect(quiet.status, quiet.stderr).toBe(0);
        expect(quiet.stdout).toBe("");
      },
    );

    it.each(SHELLS)(
      "%s runs a collector that is there, and keeps its deny and its failure",
      (shell) => {
        const { tacho } = scratch();
        const hook = `${shellQuote(tacho, "darwin")} hook`;
        const line = skipWhenCollectorAbsent(
          hook,
          `${hook} --enrollment tch_abcdefghijklmnopqrstuv --harness cursor`,
          '{"permission":"allow"}',
        );
        // The collector said deny: that is what the harness reads.
        stub(tacho, `printf '%s\\n' '{"permission":"deny"}'`);
        const denied = run(shell, line);
        expect(denied.status).toBe(0);
        expect(denied.stdout).toBe('{"permission":"deny"}\n');
        // The arguments reach it.
        stub(tacho, `printf '%s\\n' "$*"`);
        expect(run(shell, line).stdout).toBe(
          "hook --enrollment tch_abcdefghijklmnopqrstuv --harness cursor\n",
        );
        // The collector is there and fails: the failure stands, so a
        // `failClosed` hook still blocks.
        stub(tacho, "exit 3");
        const failed = run(shell, line);
        expect(failed.status).toBe(3);
        expect(failed.stdout).toBe("");
        rmSync(tacho);
      },
    );

    it("a command left unwrapped fails to spawn, which is the defect", () => {
      // What Cursor and Stella ran before ADR-230: the shell's 127, which
      // `failClosed` and Stella both read as a deny.
      const { tacho } = scratch();
      const result = run(
        "/bin/sh",
        `${shellQuote(tacho, "darwin")} hook --harness cursor`,
      );
      expect(result.status).toBe(127);
    });
  },
);
