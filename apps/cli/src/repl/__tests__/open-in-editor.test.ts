import { describe, it, expect, vi } from "vitest";
import { resolveEditorCommand, openInEditor } from "../open-in-editor.js";

const FILE = "/repo/src/a.ts";

describe("resolveEditorCommand", () => {
  it("prefers $VISUAL over $EDITOR", () => {
    const cmd = resolveEditorCommand(
      FILE,
      { VISUAL: "code --wait", EDITOR: "vim" },
      "darwin",
    );
    expect(cmd).toMatchObject({
      file: "code",
      args: ["--wait", FILE],
      terminal: false,
      label: "code",
    });
  });

  it("classifies curses editors as terminal", () => {
    for (const editor of ["vim", "nvim", "nano", "emacs -nw"]) {
      expect(
        resolveEditorCommand(FILE, { EDITOR: editor }, "linux").terminal,
      ).toBe(true);
    }
    expect(
      resolveEditorCommand(FILE, { EDITOR: "subl -w" }, "linux").terminal,
    ).toBe(false);
  });

  it("falls back to the platform opener when nothing is configured", () => {
    expect(resolveEditorCommand(FILE, {}, "darwin")).toMatchObject({
      file: "open",
      args: [FILE],
      terminal: false,
    });
    expect(resolveEditorCommand(FILE, {}, "linux")).toMatchObject({
      file: "xdg-open",
      args: [FILE],
    });
    expect(resolveEditorCommand(FILE, {}, "win32")).toMatchObject({
      file: "cmd",
      args: ["/c", "start", "", FILE],
    });
  });

  it("treats a whitespace-only $EDITOR as unset", () => {
    expect(resolveEditorCommand(FILE, { EDITOR: "  " }, "darwin").file).toBe(
      "open",
    );
  });
});

describe("openInEditor", () => {
  it("spawns GUI editors detached and reports the label", () => {
    const spawnDetached = vi.fn();
    const result = openInEditor(
      FILE,
      { spawnDetached },
      { EDITOR: "code" },
      "darwin",
    );
    expect(result).toEqual({ ok: true, label: "code" });
    expect(spawnDetached).toHaveBeenCalledWith("code", [FILE]);
  });

  it("suspends, runs blocking, and resumes for terminal editors — in order", () => {
    const calls: string[] = [];
    const result = openInEditor(
      FILE,
      {
        suspendTui: () => calls.push("suspend"),
        runBlocking: (file, args) => {
          calls.push(`run:${file}:${args.join(" ")}`);
          return { status: 0 };
        },
        resumeTui: () => calls.push("resume"),
      },
      { EDITOR: "vim" },
      "linux",
    );
    expect(result).toEqual({ ok: true, label: "vim" });
    expect(calls).toEqual(["suspend", `run:vim:${FILE}`, "resume"]);
  });

  it("still resumes the TUI when the blocking run fails", () => {
    const resumeTui = vi.fn();
    const result = openInEditor(
      FILE,
      {
        runBlocking: () => ({ status: null, error: new Error("ENOENT vim") }),
        resumeTui,
      },
      { EDITOR: "vim" },
      "linux",
    );
    expect(result).toEqual({ ok: false, error: "ENOENT vim" });
    expect(resumeTui).toHaveBeenCalledOnce();
  });

  it("reports a nonzero editor exit as a failure", () => {
    const result = openInEditor(
      FILE,
      { runBlocking: () => ({ status: 2 }) },
      { EDITOR: "vim" },
      "linux",
    );
    expect(result).toEqual({ ok: false, error: "vim exited with status 2" });
  });
});
