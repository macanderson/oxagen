/**
 * How a harness executable is spawned when Windows resolves it to a batch
 * file, which Node refuses to spawn without a shell since 20.12.
 */
import { describe, expect, it } from "vitest";
import { spawnInvocation } from "./codex-app-server";

describe("spawnInvocation", () => {
  it("spawns an executable as it is, and anything off Windows", () => {
    expect(
      spawnInvocation("C:\\codex\\codex.exe", ["app-server"], "win32", {}),
    ).toEqual({ command: "C:\\codex\\codex.exe", args: ["app-server"] });
    expect(
      spawnInvocation("/usr/local/bin/codex.cmd", ["--version"], "linux", {}),
    ).toEqual({ command: "/usr/local/bin/codex.cmd", args: ["--version"] });
  });

  it("runs a batch file through cmd.exe with the line quoted by hand", () => {
    expect(
      spawnInvocation(
        "C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd",
        ["app-server"],
        "win32",
        { ComSpec: "C:\\Windows\\system32\\cmd.exe" },
      ),
    ).toEqual({
      command: "C:\\Windows\\system32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '"C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd ^^^"app-server^^^""',
      ],
      windowsVerbatimArguments: true,
    });
    // `.bat` too, in any case, and `cmd.exe` when ComSpec is unset.
    expect(spawnInvocation("C:\\x\\RUN.BAT", [], "win32", {})).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", '"C:\\x\\RUN.BAT"'],
      windowsVerbatimArguments: true,
    });
  });

  it("escapes a path with a space and an argument with quotes and metacharacters", () => {
    const { args } = spawnInvocation(
      "C:\\Program Files\\nodejs\\codex.cmd",
      ['say "hi" & exit', "a\\\\", 'b\\"c'],
      "win32",
      {},
    );
    expect(args[3]).toBe(
      [
        '"C:\\Program^ Files\\nodejs\\codex.cmd',
        // Every cmd.exe metacharacter is escaped twice: once for `cmd /c`,
        // once for the batch file's own `%*`.
        '^^^"say^^^ \\^^^"hi\\^^^"^^^ ^^^&^^^ exit^^^"',
        // Trailing backslashes are doubled so the closing quote stays one.
        '^^^"a\\\\\\\\^^^"',
        // Backslashes before a quote are doubled and the quote escaped.
        '^^^"b\\\\\\^^^"c^^^""',
      ].join(" "),
    );
  });
});
