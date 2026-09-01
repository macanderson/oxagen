/**
 * Additional coverage for buildWorkspaceTools — tools not exercised by tools.test.ts:
 * write_file, list_dir, search, delete_file, code_graph execute, bash error/timeout paths.
 */
import { describe, it, expect } from "vitest";
import { MemoryWorkspace } from "./workspaces/memory";
import {
  buildWorkspaceTools,
  formatWithLineNumbers,
  describeEditFailure,
  clip,
  clipMiddle,
  readFileTruncationMarker,
  resolveDisplayPath,
} from "./tools";
import type { CodingEvent } from "./types";

async function run(tool: unknown, input: unknown): Promise<string> {
  return (
    tool as { execute: (i: unknown, o: unknown) => Promise<string> }
  ).execute(input, {});
}

describe("resolveDisplayPath", () => {
  it("joins a relative path onto the workspace root", () => {
    expect(resolveDisplayPath("/repo", "src/a.ts")).toBe("/repo/src/a.ts");
  });

  it("tolerates a trailing slash on the root", () => {
    expect(resolveDisplayPath("/repo/", "a.ts")).toBe("/repo/a.ts");
  });

  it("returns absolute POSIX and Windows paths unchanged", () => {
    expect(resolveDisplayPath("/repo", "/elsewhere/a.ts")).toBe(
      "/elsewhere/a.ts",
    );
    expect(resolveDisplayPath("/repo", "C:\\work\\a.ts")).toBe(
      "C:\\work\\a.ts",
    );
  });
});

describe("buildWorkspaceTools – write_file", () => {
  it("creates a new file and returns a byte-count confirmation", async () => {
    const ws = new MemoryWorkspace({});
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.write_file, {
      path: "new.ts",
      content: "hello",
    });
    expect(result).toContain("5");
    expect(result).toContain("new.ts");
    expect(await ws.readFile("new.ts")).toBe("hello");
  });

  it("echoes the RESOLVED absolute path in the write confirmation (worktree divergence guard)", async () => {
    const ws = new MemoryWorkspace({});
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.write_file, {
      path: "new.ts",
      content: "hello",
    });
    expect(result).toBe("Wrote 5 bytes to /repo/new.ts");
  });

  it("emits a file-edit event on write", async () => {
    const ws = new MemoryWorkspace({});
    const events: CodingEvent[] = [];
    const tools = buildWorkspaceTools(ws, { onEvent: (e) => events.push(e) });
    await run(tools.write_file, { path: "x.ts", content: "abc" });
    expect(
      events.some((e) => e.type === "file-edit" && e.path === "x.ts"),
    ).toBe(true);
  });

  it("returns an error string when write fails", async () => {
    const ws = new MemoryWorkspace({});
    // Simulate writeFile throwing
    ws.writeFile = async () => {
      throw new Error("disk full");
    };
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.write_file, {
      path: "fail.ts",
      content: "x",
    });
    expect(result).toContain("Error writing");
    expect(result).toContain("disk full");
  });
});

describe("buildWorkspaceTools – list_dir", () => {
  it("returns entries of a directory", async () => {
    const ws = new MemoryWorkspace({
      "src/a.ts": "",
      "src/b.ts": "",
      "src/sub/c.ts": "",
    });
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.list_dir, { path: "src" });
    expect(result).toContain("a.ts");
    expect(result).toContain("b.ts");
    expect(result).toContain("sub");
  });

  it("returns (empty) for an empty directory", async () => {
    const ws = new MemoryWorkspace({});
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.list_dir, { path: "." });
    expect(result).toBe("(empty)");
  });

  it("returns an error string when list fails", async () => {
    const ws = new MemoryWorkspace({});
    ws.list = async () => {
      throw new Error("permission denied");
    };
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.list_dir, { path: "restricted" });
    expect(result).toContain("Error listing");
    expect(result).toContain("permission denied");
  });
});

describe("buildWorkspaceTools – search (by file name)", () => {
  it("returns sorted name matches under the name header", async () => {
    const ws = new MemoryWorkspace({
      "src/b.ts": "",
      "src/a.ts": "",
      "lib/c.js": "",
    });
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.search, { query: ".ts" });
    expect(result).toBe("Files matching by name:\nsrc/a.ts\nsrc/b.ts");
    expect(result).not.toContain("lib/c.js");
  });

  it("matches names case-insensitively on substring", async () => {
    const ws = new MemoryWorkspace({ "src/ConfigLoader.ts": "" });
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.search, { query: "configloader" });
    expect(result).toContain("src/ConfigLoader.ts");
  });

  it("returns (no matches) for a query with no results", async () => {
    const ws = new MemoryWorkspace({});
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.search, { query: "zzz" });
    expect(result).toBe("(no matches)");
  });
});

describe("buildWorkspaceTools – search (by content)", () => {
  it("returns file:line:text hits under the content header", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "const x = 1\nconst y = 2" });
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.search, { query: "const y" });
    expect(result).toBe("Content matches:\na.ts:2:const y = 2");
  });

  it("returns both sections, names first, when a query matches on both axes", async () => {
    const ws = new MemoryWorkspace({ "src/config.ts": "load config here" });
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.search, { query: "config" });
    expect(result).toBe(
      "Files matching by name:\nsrc/config.ts\n\n" +
        "Content matches:\nsrc/config.ts:1:load config here",
    );
  });

  it("treats a query that does not compile as a regex as a literal", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "call foo( now" });
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.search, { query: "foo(" });
    expect(result).toContain("a.ts:1:call foo( now");
  });

  it("returns (no matches) when the query is not found", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "hello" });
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.search, { query: "zzz" });
    expect(result).toBe("(no matches)");
  });

  it("still reports name matches when the content axis fails", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "hello" });
    ws.grep = async () => {
      throw new Error("regex engine exploded");
    };
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.search, { query: "a.ts" });
    expect(result).toBe("Files matching by name:\nsrc/a.ts");
  });

  it("degrades to (no matches) when both axes fail", async () => {
    const ws = new MemoryWorkspace({});
    ws.grep = async () => {
      throw new Error("boom");
    };
    ws.glob = async () => {
      throw new Error("boom");
    };
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.search, { query: "anything" });
    expect(result).toBe("(no matches)");
  });
});

describe("buildWorkspaceTools – delete_file", () => {
  it("deletes a file, after which read_file errors with ENOENT", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "doomed" });
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.delete_file, {
      path: "a.ts",
      reason: "obsolete",
    });
    expect(result).toBe("Deleted a.ts");
    const read = await run(tools.read_file, { path: "a.ts" });
    expect(read).toContain("Error reading a.ts");
    expect(read).toContain("ENOENT");
  });

  it("emits a command event on delete", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "" });
    const events: CodingEvent[] = [];
    const tools = buildWorkspaceTools(ws, { onEvent: (e) => events.push(e) });
    await run(tools.delete_file, { path: "a.ts" });
    expect(
      events.some(
        (e) =>
          e.type === "command" &&
          e.command === "delete_file a.ts" &&
          e.exitCode === 0,
      ),
    ).toBe(true);
  });

  it("returns an error string when the file does not exist", async () => {
    const ws = new MemoryWorkspace({});
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.delete_file, { path: "missing.ts" });
    expect(result).toContain("Error deleting missing.ts");
    expect(result).toContain("ENOENT");
  });

  it("is absent when the workspace does not implement deleteFile", () => {
    const ws = new MemoryWorkspace({});
    // Shadow the prototype method: a workspace without the capability simply
    // has no deleteFile, and presence — not a flag — gates the tool.
    (ws as { deleteFile?: MemoryWorkspace["deleteFile"] }).deleteFile =
      undefined;
    const tools = buildWorkspaceTools(ws);
    expect(tools.delete_file).toBeUndefined();
    expect(tools.search).toBeDefined();
  });

  it("is withheld in readOnly mode like the other mutators", () => {
    const ws = new MemoryWorkspace({ "a.ts": "" });
    const tools = buildWorkspaceTools(ws, { readOnly: true });
    expect(tools.delete_file).toBeUndefined();
    expect(tools.write_file).toBeUndefined();
    expect(tools.edit_file).toBeUndefined();
  });
});

describe("buildWorkspaceTools – read_file error path", () => {
  it("returns an error string when file does not exist", async () => {
    const ws = new MemoryWorkspace({});
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.read_file, { path: "missing.ts" });
    expect(result).toContain("Error reading missing.ts");
    expect(result).toContain("ENOENT");
  });
});

describe("buildWorkspaceTools – edit_file error path", () => {
  it("returns an error string when old_string is not found", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "hello" });
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.edit_file, {
      path: "a.ts",
      old_string: "zzz",
      new_string: "x",
    });
    expect(result).toContain("Error editing a.ts");
    expect(result).toContain("not found");
  });
});

describe("buildWorkspaceTools – bash error paths", () => {
  it("returns a timed-out message when exec timedOut is true", async () => {
    const ws = new MemoryWorkspace({});
    ws.onExec(() => ({
      exitCode: 124,
      stdout: "",
      stderr: "",
      timedOut: true,
    }));
    const events: CodingEvent[] = [];
    const tools = buildWorkspaceTools(ws, { onEvent: (e) => events.push(e) });
    const result = await run(tools.bash, {
      command: "sleep 9999",
      timeout_secs: 1,
    });
    expect(result).toContain("timed out");
    // event is still emitted before the timedOut check
    expect(events.some((e) => e.type === "command")).toBe(true);
  });

  it("returns a failure message when exit code is non-zero", async () => {
    const ws = new MemoryWorkspace({});
    ws.onExec(() => ({
      exitCode: 1,
      stdout: "",
      stderr: "build failed",
      timedOut: false,
    }));
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.bash, { command: "pnpm build" });
    expect(result).toContain("Command failed");
    expect(result).toContain("build failed");
  });

  it("returns an error string when exec throws", async () => {
    const ws = new MemoryWorkspace({});
    ws.exec = async () => {
      throw new Error("spawn failed");
    };
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.bash, { command: "bad-cmd" });
    expect(result).toContain("Error running command");
    expect(result).toContain("spawn failed");
  });

  it("caps timeout_secs at 600 seconds (600000ms on the exec)", async () => {
    const ws = new MemoryWorkspace({});
    const observed: number[] = [];
    ws.exec = async (_cmd, opts) => {
      observed.push(opts?.timeoutMs ?? -1);
      return { exitCode: 0, stdout: "ok", stderr: "", timedOut: false };
    };
    const tools = buildWorkspaceTools(ws);
    await run(tools.bash, { command: "echo", timeout_secs: 9_999_999 });
    expect(observed[0]).toBe(600_000);
  });

  it("defaults the exec timeout to 120 seconds when timeout_secs is omitted", async () => {
    const ws = new MemoryWorkspace({});
    const observed: number[] = [];
    ws.exec = async (_cmd, opts) => {
      observed.push(opts?.timeoutMs ?? -1);
      return { exitCode: 0, stdout: "ok", stderr: "", timedOut: false };
    };
    const tools = buildWorkspaceTools(ws);
    await run(tools.bash, { command: "echo" });
    expect(observed[0]).toBe(120_000);
  });
});

describe("per-tool timeout backstop", () => {
  it("toolBackstopMs honors bash's declared timeout_secs plus grace, capped at max", async () => {
    // The schema key: a bash {timeout_secs: 500} call must move the backstop,
    // or a long build gets a false "timed out" at 150s while still running.
    const { toolBackstopMs } = await import("./tools");
    expect(toolBackstopMs("bash", { timeout_secs: 500 })).toBe(530_000);
    expect(toolBackstopMs("bash", {})).toBe(150_000); // default 120s + 30s grace
    expect(toolBackstopMs("bash", { timeout_secs: 9_999 })).toBe(630_000); // capped at 600s
    expect(toolBackstopMs("read_file", {})).toBe(60_000);
    expect(toolBackstopMs("search", null)).toBe(60_000);
  });

  it("a wedged tool resolves to a backstop timeout string instead of hanging", async () => {
    const { vi } = await import("vitest");
    vi.useFakeTimers();
    try {
      const ws = new MemoryWorkspace({});
      // Wedge the content axis: search awaits it, so the backstop must fire
      // at 60s.
      ws.grep = () => new Promise(() => {});
      const tools = buildWorkspaceTools(ws);
      const pending = run(tools.search, { query: "x" });
      await vi.advanceTimersByTimeAsync(60_001);
      const out = await pending;
      expect(out).toContain("timed out after 60s (backstop)");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("formatWithLineNumbers", () => {
  it("prefixes each line with a right-aligned number and a tab", () => {
    expect(formatWithLineNumbers("a\nb\nc")).toBe("1\ta\n2\tb\n3\tc");
  });

  it("reflects the true starting line number (offset-based) and right-aligns", () => {
    // 10 lines starting at line 2 pushes the max number to 11 → width 2, so the
    // single-digit numbers are space-padded.
    const text = Array.from({ length: 10 }, (_, i) => `L${i}`).join("\n");
    const out = formatWithLineNumbers(text, 2);
    expect(out.startsWith(" 2\tL0\n")).toBe(true);
    expect(out).toContain("11\tL9");
  });

  it("does not number the empty tail after a trailing newline", () => {
    expect(formatWithLineNumbers("a\nb\n")).toBe("1\ta\n2\tb");
  });

  it("returns an empty string for empty input", () => {
    expect(formatWithLineNumbers("")).toBe("");
  });
});

describe("buildWorkspaceTools – read_file line numbers", () => {
  it("numbers lines with their true file line number when offset is given", async () => {
    const ws = new MemoryWorkspace({ "n.txt": "l1\nl2\nl3\nl4\nl5" });
    const tools = buildWorkspaceTools(ws);
    const out = await run(tools.read_file, {
      path: "n.txt",
      offset: 2,
      limit: 2,
    });
    expect(out).toBe("2\tl2\n3\tl3");
  });

  it("gives an actionable, line-aware truncation hint for an over-cap whole-file read", async () => {
    // A large MULTI-LINE file: the model should learn the total line count and
    // the exact offset/limit to fetch the elided middle it can't see.
    const lines = Array.from(
      { length: 5000 },
      (_, i) => `line ${i + 1}: ${"x".repeat(20)}`,
    );
    const ws = new MemoryWorkspace({ "big.txt": lines.join("\n") });
    const tools = buildWorkspaceTools(ws);
    const out = await run(tools.read_file, { path: "big.txt" });
    expect(out).toContain("5000 lines total");
    expect(out).toMatch(/offset:\d+/);
    expect(out).toMatch(/limit:\d+/);
    // Still capped like every other over-cap tool output.
    expect(out.length).toBeLessThan(31_000);
  });

  it("keeps the generic middle-out marker for a RANGE read that overflows the cap", async () => {
    // offset/limit were supplied, so the model already chose a span — no
    // line-aware recovery hint, just the generic char-count note.
    const lines = Array.from(
      { length: 5000 },
      (_, i) => `line ${i + 1}: ${"x".repeat(20)}`,
    );
    const ws = new MemoryWorkspace({ "big.txt": lines.join("\n") });
    const tools = buildWorkspaceTools(ws);
    const out = await run(tools.read_file, {
      path: "big.txt",
      offset: 1,
      limit: 5000,
    });
    expect(out).toContain("truncated from the middle");
    expect(out).not.toContain("lines total");
    expect(out.length).toBeLessThan(31_000);
  });
});

describe("readFileTruncationMarker", () => {
  it("emits a concrete offset/limit hint when a middle span of lines is elided", () => {
    const marker = readFileTruncationMarker(5000);
    const msg = marker({
      dropped: 120_000,
      head: Array.from({ length: 900 }, () => "h").join("\n"), // 900 head lines
      tail: Array.from({ length: 600 }, () => "t").join("\n"), // 600 tail lines
    });
    expect(msg).toContain("5000 lines total");
    expect(msg).toContain("offset:900");
    expect(msg).toContain("limit:3500"); // 5000 - 900 - 600
  });

  it("falls back to a char-oriented note for a single over-cap line (no line range)", () => {
    const marker = readFileTruncationMarker(1);
    const msg = marker({
      dropped: 10_000,
      head: "h".repeat(18_000),
      tail: "t".repeat(12_000),
    });
    expect(msg).toContain("1 line(s)");
    expect(msg).not.toContain("offset:");
  });
});

describe("clip (middle-out truncation)", () => {
  it("returns short text unchanged", () => {
    expect(clip("hello")).toBe("hello");
  });

  it("keeps BOTH the head and the tail, dropping the middle", () => {
    // HEAD marker at the very start, TAIL marker at the very end — the tail is
    // where a failing test/build puts its verdict, which head-only truncation lost.
    const text = "HEAD_START" + "m".repeat(40_000) + "TAIL_END";
    const out = clip(text);
    expect(out.startsWith("HEAD_START")).toBe(true);
    expect(out.endsWith("TAIL_END")).toBe(true);
    expect(out).toContain("truncated from the middle");
    expect(out.length).toBeLessThan(31_000);
  });
});

describe("clipMiddle (parameterized middle-out truncation)", () => {
  it("returns text at or under the cap unchanged", () => {
    expect(clipMiddle("small", 10_000)).toBe("small");
    expect(clipMiddle("x".repeat(100), 100)).toBe("x".repeat(100));
  });

  it("clips to an arbitrary cap with a char-count marker, keeping head + tail", () => {
    const text = "HEAD" + "z".repeat(20_000) + "TAIL";
    const out = clipMiddle(text, 5_000);
    expect(out.startsWith("HEAD")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
    expect(out).toContain("truncated from the middle");
    // head (⌊0.6·5000⌋=3000) + tail (2000) + short marker → bounded near the cap.
    expect(out.length).toBeLessThan(5_200);
    // Marker reports the exact elided count: 20008 total − 5000 kept = 15008.
    expect(out).toContain(`${text.length - 5_000} chars truncated`);
  });

  it("applies the tighter 10k stderr budget the exec envelope uses", () => {
    const out = clipMiddle("e".repeat(50_000), 10_000);
    expect(out).toContain("truncated from the middle");
    expect(out.length).toBeLessThan(10_500);
  });

  it("honors a custom head fraction", () => {
    const text = "A".repeat(1_000) + "B".repeat(1_000);
    const out = clipMiddle(text, 100, 0.5);
    expect(out.startsWith("A".repeat(50))).toBe(true); // head = 50% of 100
    expect(out.endsWith("B".repeat(50))).toBe(true); // tail = the remaining 50
  });
});

describe("describeEditFailure", () => {
  it("returns null when old_string appears exactly once", () => {
    expect(describeEditFailure("a\nunique\nb", "unique")).toBeNull();
  });

  it("names the closest line and hints at whitespace when not found", () => {
    const msg = describeEditFailure(
      "const foo = 1;\nconst bar = 2;",
      "const fooo = 1;",
    );
    expect(msg).toContain("not found");
    expect(msg).toContain("Closest match at line 1");
    expect(msg).toContain("const foo = 1;");
    expect(msg).toContain("Check exact whitespace");
  });

  it("lists occurrence line numbers and suggests replace_all when ambiguous", () => {
    const msg = describeEditFailure("x\ny\nx\nz\nx", "x");
    expect(msg).toContain("appears 3 times");
    expect(msg).toContain("lines 1, 3, 5");
    expect(msg).toContain("replace_all");
  });
});

describe("buildWorkspaceTools – edit_file replace_all + structured feedback", () => {
  it("replace_all replaces every occurrence and reports the count", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "a\na\na" });
    const tools = buildWorkspaceTools(ws);
    const out = await run(tools.edit_file, {
      path: "a.ts",
      old_string: "a",
      new_string: "b",
      replace_all: true,
    });
    expect(out).toContain("3 replacements");
    expect(await ws.readFile("a.ts")).toBe("b\nb\nb");
  });

  it("echoes the RESOLVED absolute path on a single-match edit (worktree divergence guard)", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "foo bar" });
    const tools = buildWorkspaceTools(ws);
    const out = await run(tools.edit_file, {
      path: "a.ts",
      old_string: "bar",
      new_string: "baz",
    });
    // The confirmation echoes the RESOLVED absolute path, plus the edit-integrity
    // anchor chain (before → after content hash) appended by the always-on gate.
    expect(out).toMatch(
      /^Edited \/repo\/a\.ts \(1 replacement\) \[anchor [0-9a-f]{16} → [0-9a-f]{16}\]$/,
    );
  });

  it("keeps an absolute input path as-is in the edit confirmation", async () => {
    const ws = new MemoryWorkspace({ "/repo/a.ts": "foo bar" });
    const tools = buildWorkspaceTools(ws);
    const out = await run(tools.edit_file, {
      path: "/repo/a.ts",
      old_string: "bar",
      new_string: "baz",
    });
    expect(out).toMatch(
      /^Edited \/repo\/a\.ts \(1 replacement\) \[anchor [0-9a-f]{16} → [0-9a-f]{16}\]$/,
    );
  });

  it("names the closest line when old_string is not found", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "const foo = 1;" });
    const tools = buildWorkspaceTools(ws);
    const out = await run(tools.edit_file, {
      path: "a.ts",
      old_string: "const fooo = 1;",
      new_string: "x",
    });
    expect(out).toContain("Error editing a.ts");
    expect(out).toContain("Closest match at line 1");
  });

  it("lists lines and suggests replace_all on an ambiguous match, without mutating", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "x\nx\nx" });
    const tools = buildWorkspaceTools(ws);
    const out = await run(tools.edit_file, {
      path: "a.ts",
      old_string: "x",
      new_string: "y",
    });
    expect(out).toContain("appears 3 times");
    expect(out).toContain("replace_all");
    expect(await ws.readFile("a.ts")).toBe("x\nx\nx");
  });
});
