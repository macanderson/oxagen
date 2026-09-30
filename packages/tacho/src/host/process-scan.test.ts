/**
 * The `/proc` reads that let a hook find its harness without spawning `ps`
 * (#4358), and the start-time read that answers later where it has to run
 * `ps` (#4366). `readProcessStarts` itself is covered in
 * `collector/pid-identity.test.ts`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  procParent,
  readProcessStartsNoWait,
  readProcParent,
} from "./process-scan";
import type { ExecAsync } from "./service";

const BOOT = "9f0c2b7e-51a4-4a4e-8d0b-3c1e7f2a6b90";

/** A `/proc/<pid>/stat` line whose command name holds spaces and parentheses. */
const stat = (pid: number, ppid: number, ticks: number) =>
  `${pid} (tacho (hook) x) S ${ppid} ${pid} ${pid} 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 4 0 ${ticks} 12345678 900 18446744073709551615\n`;

describe("procParent", () => {
  it("reads the name and the parent pid around a name that holds parentheses", () => {
    expect(procParent(stat(5555, 4242, 98765))).toEqual({
      ppid: 4242,
      comm: "tacho (hook) x",
    });
    expect(procParent("5555 (bash) S 4242 5555")).toEqual({
      ppid: 4242,
      comm: "bash",
    });
  });

  it("answers nothing for a line it cannot read", () => {
    expect(procParent("garbage")).toBeUndefined();
    expect(procParent("5555 (bash) S")).toBeUndefined();
    expect(procParent("5555 (bash) S x")).toBeUndefined();
    expect(procParent("5555 bash) S 4242")).toBeUndefined();
  });
});

describe("readProcParent", () => {
  it("reads /proc/<pid>/stat, and answers nothing where there is none", () => {
    const files: Record<string, string> = {
      "/proc/5555/stat": stat(5555, 4242, 1),
    };
    const read = (path: string) => files[path];
    expect(readProcParent(5555, read)).toEqual({
      ppid: 4242,
      comm: "tacho (hook) x",
    });
    // macOS has no /proc, and a pid with no process has no file.
    expect(readProcParent(6666, read)).toBeUndefined();
  });

  it.runIf(process.platform === "linux")(
    "reads this process's parent from the real /proc",
    () => {
      const parent = readProcParent(process.pid);
      expect(parent?.ppid).toBe(process.ppid);
      const line = readFileSync("/proc/self/stat", "utf8");
      expect(parent?.comm).toBe(
        line.slice(line.indexOf("(") + 1, line.lastIndexOf(")")),
      );
    },
  );
});

describe("readProcessStartsNoWait", () => {
  const files: Record<string, string> = {
    "/proc/sys/kernel/random/boot_id": `${BOOT}\n`,
    "/proc/4242/stat": stat(4242, 1, 98765),
  };
  const read = (path: string) => files[path];

  it("answers at once on Linux, from /proc, and runs no ps", () => {
    let ran = false;
    const exec: ExecAsync = async () => {
      ran = true;
      return { status: 0, stdout: "", stderr: "" };
    };
    expect(readProcessStartsNoWait([4242], exec, "linux", read)).toEqual(
      new Map([[4242, `${BOOT}:98765`]]),
    );
    expect(ran).toBe(false);
  });

  it("answers nothing on Windows, or for no pids, without running anything", () => {
    let ran = false;
    const exec: ExecAsync = async () => {
      ran = true;
      return { status: 0, stdout: "", stderr: "" };
    };
    expect(
      readProcessStartsNoWait([4242], exec, "win32", read),
    ).toBeUndefined();
    expect(readProcessStartsNoWait([], exec, "darwin", read)).toBeUndefined();
    expect(ran).toBe(false);
  });

  it("answers with a promise where it runs ps, and nothing when ps fails", async () => {
    const calls: string[][] = [];
    const exec: ExecAsync = async (command, args) => {
      calls.push([command, ...args]);
      return {
        status: 0,
        stdout: "4242 Fri Sep 25 09:00:00 2026\n",
        stderr: "",
      };
    };
    const answer = readProcessStartsNoWait([4242], exec, "darwin", read);
    expect(answer).toBeInstanceOf(Promise);
    await expect(answer).resolves.toEqual(
      new Map([[4242, "Fri Sep 25 09:00:00 2026"]]),
    );
    expect(calls).toEqual([["ps", "-o", "pid=,lstart=", "-p", "4242"]]);
    await expect(
      readProcessStartsNoWait(
        [4242],
        () => Promise.reject(new Error("spawn ps ENOENT")),
        "darwin",
        read,
      ),
    ).resolves.toBeUndefined();
  });
});
