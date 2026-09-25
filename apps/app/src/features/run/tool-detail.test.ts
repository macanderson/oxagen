import { toolFamilyOf } from "@oxagen/run-ledger";
import { describe, expect, it } from "vitest";
import {
  callDetail,
  compactArgs,
  parseBody,
  shortName,
  shortPath,
  splitBody,
  toolDetail,
  toolDetailOf,
} from "./tool-detail";

/** The body as the recorder writes it: JSON, on one line. */
function body(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * One body read the way the transcript reads it, with the family the server
 * states for the tool's name (`toolFamilyOf`, ADR-182). The page keeps no
 * family table, so the tests read the one the server does.
 */
function read(name: string | null, text: string | null) {
  return toolDetail(name, toolFamilyOf(name ?? ""), text);
}

describe("parseBody", () => {
  it("reads a JSON object or array", () => {
    expect(parseBody('{"a":1}')).toEqual({ a: 1 });
    expect(parseBody("[1,2]")).toEqual([1, 2]);
    expect(parseBody('  {"a":1}  ')).toEqual({ a: 1 });
  });

  it("returns null rather than throw on anything else", () => {
    expect(parseBody(null)).toBeNull();
    expect(parseBody("")).toBeNull();
    expect(parseBody("   ")).toBeNull();
    expect(parseBody("not json")).toBeNull();
    // A truncated body is common on a long run and must not throw.
    expect(parseBody('{"command": "git sta')).toBeNull();
  });
});

describe("splitBody", () => {
  it("reads the `{input, output}` shape a tool_call writes", () => {
    expect(splitBody({ input: { command: "ls" }, output: "a\nb" })).toEqual({
      input: { command: "ls" },
      output: "a\nb",
      name: null,
    });
  });

  it("reads the `{tool_use}` shape a content block writes", () => {
    expect(
      splitBody({
        tool_use: { id: "toolu_1", name: "Skill", input: { skill: "x" } },
      }),
    ).toEqual({ input: { skill: "x" }, output: null, name: "Skill" });
  });

  it("treats a bare body as the input, which is what tool_requested writes", () => {
    expect(splitBody({ file_path: "/a/b.ts" })).toEqual({
      input: { file_path: "/a/b.ts" },
      output: null,
      name: null,
    });
  });

  it("carries nothing out of a body that is not an object", () => {
    for (const value of [null, "text", 3, [1]]) {
      expect(splitBody(value)).toEqual({
        input: null,
        output: null,
        name: null,
      });
    }
  });
});

describe("shortPath", () => {
  it("keeps the last two segments of a long path", () => {
    expect(shortPath("/Users/x/Projects/oxagen/apps/app/src/kernel.ts")).toBe(
      "…/src/kernel.ts",
    );
  });

  it("leaves a short path whole", () => {
    expect(shortPath("src/kernel.ts")).toBe("src/kernel.ts");
    expect(shortPath("kernel.ts")).toBe("kernel.ts");
    expect(shortPath("")).toBe("");
  });
});

describe("shortName", () => {
  it("drops a harness prefix, a version and the MCP marker, and keeps the server", () => {
    expect(shortName("claude_code__Bash")).toBe("Bash");
    expect(shortName("Read@2.1.4")).toBe("Read");
    expect(shortName("mcp__github__create_release")).toBe(
      "github__create_release",
    );
    expect(shortName("github__list_pull_requests")).toBe(
      "github__list_pull_requests",
    );
  });
});

describe("toolDetail", () => {
  it("returns null when nothing names the tool", () => {
    expect(read(null, null)).toBeNull();
    expect(read(null, body({ input: { command: "ls" } }))).toBeNull();
  });

  it("takes the name from the body when the frame carried none", () => {
    const detail = read(
      null,
      body({ tool_use: { name: "Bash", input: { command: "ls -la" } } }),
    );
    expect(detail?.name).toBe("Bash");
    expect(detail?.headline).toBe("ls -la");
  });

  it("reads a value already parsed the same way (a model's tool_use block)", () => {
    expect(
      toolDetailOf(
        "Grep",
        "search",
        { pattern: "TODO", path: "/repo/src" },
        "3 matches",
      ),
    ).toMatchObject({
      headline: "TODO",
      detail: "in /repo/src",
      output: "3 matches",
    });
  });

  it("reads a body by the family it is given, not by its name", () => {
    // The family is the server's; a tool this page never heard of reads by
    // the family the record states.
    expect(
      toolDetail("run_tests", "shell", body({ input: { command: "pnpm t" } })),
    ).toMatchObject({ name: "run_tests", group: "shell", headline: "pnpm t" });
  });

  describe("shell", () => {
    it("heads the line with the command and keeps the command whole as the call", () => {
      const detail = read(
        "Bash",
        body({ input: { command: "git status", description: "Tree" } }),
      );
      expect(detail).toMatchObject({
        name: "Bash",
        group: "shell",
        headline: "git status",
        detail: "Tree",
        multiline: false,
        raw: "git status",
        output: null,
        diffs: [],
      });
    });

    it("heads a multiline command with its first line", () => {
      const detail = read(
        "Bash",
        body({ input: { command: "cd app\npnpm test" } }),
      );
      expect(detail?.headline).toBe("cd app");
      expect(detail?.multiline).toBe(true);
      expect(detail?.raw).toBe("cd app\npnpm test");
    });

    it("falls back to the description when no command was recorded", () => {
      const detail = read(
        "Bash",
        body({ input: { description: "List files" } }),
      );
      expect(detail?.headline).toBe("List files");
      expect(detail?.detail).toBeNull();
      // With no command the call is its input, as formatted JSON.
      expect(detail?.raw).toBe('{\n  "description": "List files"\n}');
    });
  });

  describe("a command's output", () => {
    const out = (output: unknown) =>
      read("Bash", body({ input: { command: "x" }, output }))?.output;

    it("reads a bare string, and nothing for an empty one", () => {
      expect(out("a\nb")).toBe("a\nb");
      expect(out("")).toBeNull();
    });

    it("joins stdout and stderr in that order, and reads either alone", () => {
      expect(out({ stdout: "ok", stderr: "warn" })).toBe("ok\nwarn");
      expect(out({ stdout: "", stderr: "boom" })).toBe("boom");
    });

    it("reads nothing out of streams that carried nothing (negative)", () => {
      expect(out({ stdout: "", stderr: "" })).toBeNull();
    });

    it("falls back to whichever text key the producer used", () => {
      expect(out({ result: "done" })).toBe("done");
      expect(out({ message: "sent" })).toBe("sent");
    });

    it("reads a Read's file contents out of its result", () => {
      expect(out({ type: "text", file: { content: "# Title" } })).toBe(
        "# Title",
      );
    });

    it("keeps an output with no text as formatted JSON rather than drop it", () => {
      expect(out({ count: 3 })).toBe('{\n  "count": 3\n}');
    });
  });

  describe("read", () => {
    it("heads the line with the file and says which lines were read", () => {
      const detail = read(
        "Read",
        body({
          input: {
            file_path: "/repo/apps/app/src/kernel.ts",
            offset: 9,
            limit: 20,
          },
        }),
      );
      expect(detail).toMatchObject({
        group: "read",
        headline: "…/src/kernel.ts",
        detail: "lines 10–29",
      });
    });

    it("says an open-ended range, and nothing when none was recorded", () => {
      expect(
        read("Read", body({ input: { file_path: "a.ts", offset: 4 } }))?.detail,
      ).toBe("lines 5+");
      expect(
        read("Read", body({ input: { file_path: "a.ts" } }))?.detail,
      ).toBeNull();
    });

    it("leaves the headline empty when the body recorded no path", () => {
      expect(read("Read", body({ input: {} }))?.headline).toBeNull();
    });

    it("reads a delete the same way it reads a read", () => {
      expect(
        read("rm", body({ input: { path: "/repo/tmp/x.log" } })),
      ).toMatchObject({ group: "delete", headline: "…/tmp/x.log" });
    });
  });

  describe("edit", () => {
    it("draws the change as a diff against the file it changed", () => {
      const detail = read(
        "Edit",
        body({
          input: {
            file_path: "/repo/src/a.ts",
            old_string: "const a = 1;",
            new_string: "const a = 2;",
          },
        }),
      );
      expect(detail?.headline).toBe("…/src/a.ts");
      expect(detail?.detail).toBeNull();
      expect(detail?.diffs).toHaveLength(1);
      expect(detail?.diffs[0]).toMatchObject({
        path: "/repo/src/a.ts",
        created: false,
        diff: { added: 1, removed: 1 },
      });
    });

    it("gives a MultiEdit one diff per replacement, in order, and skips an entry that is not one", () => {
      const detail = read(
        "MultiEdit",
        body({
          input: {
            file_path: "a.ts",
            edits: [
              { old_string: "a", new_string: "b" },
              "not an edit",
              { oldString: "c", newString: "d\ne" },
            ],
          },
        }),
      );
      expect(detail?.diffs.map((each) => each.diff.added)).toEqual([1, 2]);
    });

    it("records a one-sided replacement as the diff it is", () => {
      const detail = read(
        "Edit",
        body({ input: { file_path: "a.ts", new_string: "added" } }),
      );
      expect(detail?.diffs[0]?.diff).toMatchObject({ added: 1, removed: 0 });
    });

    it("draws nothing for an edit that recorded neither side, and says when no path was recorded", () => {
      expect(
        read("Edit", body({ input: { file_path: "a.ts" } }))?.diffs,
      ).toEqual([]);
      expect(
        read("Edit", body({ input: { old_string: "a", new_string: "b" } }))
          ?.diffs[0]?.path,
      ).toBe("(no path recorded)");
    });

    it("reads a notebook edit as an edit", () => {
      const detail = read(
        "NotebookEdit",
        body({
          input: { notebook_path: "n.ipynb", old_string: "x", new_string: "y" },
        }),
      );
      expect(detail?.group).toBe("notebook");
      expect(detail?.diffs).toHaveLength(1);
    });
  });

  describe("create", () => {
    it("reads a new file as a diff of additions", () => {
      const detail = read(
        "Write",
        body({
          input: {
            file_path: "/repo/docs/NOTES.md",
            content: "# Notes\n\nOne.",
          },
        }),
      );
      expect(detail?.headline).toBe("…/docs/NOTES.md");
      expect(detail?.diffs[0]).toMatchObject({
        path: "/repo/docs/NOTES.md",
        created: true,
        diff: { added: 3, removed: 0 },
      });
    });

    it("draws no diff for a create that recorded no contents (negative)", () => {
      expect(
        read("Write", body({ input: { file_path: "a.ts" } }))?.diffs,
      ).toEqual([]);
    });
  });

  describe("a search, a fetch, a skill, a subagent and a plan", () => {
    it("heads a search with its pattern and says where it looked", () => {
      expect(
        read("Grep", body({ input: { pattern: "TODO", path: "/r/a/src" } })),
      ).toMatchObject({
        group: "search",
        headline: "TODO",
        detail: "in …/a/src",
      });
      expect(
        read("Glob", body({ input: { pattern: "**/*.ts" } })),
      ).toMatchObject({ headline: "**/*.ts", detail: null });
    });

    it("heads a fetch with its URL, and keeps what it was asked in the call", () => {
      const detail = read(
        "WebFetch",
        body({ input: { url: "https://x.dev", prompt: "Summarize" } }),
      );
      expect(detail?.headline).toBe("https://x.dev");
      expect(detail?.raw).toContain('"prompt": "Summarize"');
    });

    it("prints a skill's version once, and only when the record carried one", () => {
      expect(
        read(
          "Skill",
          body({ input: { skill: "file-inbox", version: "v1.2" } }),
        ),
      ).toMatchObject({
        group: "skill",
        headline: "file-inbox",
        detail: "v1.2",
      });
      expect(
        read("Skill", body({ input: { skill: "file-inbox" } }))?.detail,
      ).toBeNull();
    });

    it("names a subagent by what it was asked to do, and credits its type beside it", () => {
      expect(
        read(
          "Task",
          body({
            input: {
              description: "Find the flaky test",
              subagent_type: "Explore",
              prompt: "Search the test tree.",
            },
          }),
        ),
      ).toMatchObject({
        group: "agent",
        headline: "Find the flaky test",
        detail: "Explore",
      });
      expect(
        read("Task", body({ input: { subagent_type: "Explore" } })),
      ).toMatchObject({ headline: "Explore", detail: null });
    });

    it("counts a plan's items, or reads its first line when it is prose", () => {
      expect(
        read("TodoWrite", body({ input: { todos: [{}, {}, {}] } }))?.headline,
      ).toBe("3 items");
      expect(
        read("ExitPlanMode", body({ input: { plan: "Step one\nStep two" } }))
          ?.headline,
      ).toBe("Step one");
    });
  });

  describe("a tool with no shape of its own", () => {
    it("heads the line with its arguments in order, the first bare and the rest by name", () => {
      const detail = read(
        "mcp__github__list_pull_requests",
        body({
          input: {
            repo: "a-intel/platform",
            state: "closed",
            per_page: 50,
            draft: false,
            labels: ["x"],
          },
          output: { total: 31 },
        }),
      );
      expect(detail).toMatchObject({
        name: "github__list_pull_requests",
        group: "mcp",
        headline: "a-intel/platform · state closed · per_page 50 · draft false",
        detail: null,
        output: '{\n  "total": 31\n}',
      });
      expect(detail?.raw).toContain('"labels": [');
    });

    it("reads a multi-line first value as the first line of something longer", () => {
      const detail = read(
        "run_query",
        body({ input: { sql: "select 1\nfrom t" } }),
      );
      expect(detail?.headline).toBe("select 1");
      expect(detail?.multiline).toBe(true);
    });

    it("fills the headline from every argument when none is a scalar, rather than leave it blank (#4116)", () => {
      const detail = read(
        "mcp__linear__search",
        body({
          input: { filter: { state: "open", team: "core" }, ids: [1, 2] },
        }),
      );
      expect(detail).toMatchObject({
        headline: 'filter {"state":"open","team":"core"} · ids [1,2]',
        multiline: false,
      });
    });

    it("fills the headline of a shaped tool whose reading found nothing, from what it kept", () => {
      expect(read("Read", body({ input: { limit: 20 } }))?.headline).toBe(
        "limit 20",
      );
      expect(
        read("Task", body({ input: { prompt: "Look\ncloser" } }))?.headline,
      ).toBe("prompt Look");
    });

    it("has no headline and no call for an input that carried nothing (negative)", () => {
      const detail = read("run_query", body({ input: {} }));
      expect(detail?.headline).toBeNull();
      expect(detail?.raw).toBeNull();
    });
  });
});

describe("compactArgs", () => {
  it("names every argument it kept, on one line, in the order the call gave them", () => {
    expect(
      compactArgs({ repo: "a/b", page: 2, opts: { draft: true }, tags: [] }),
    ).toBe('repo a/b · page 2 · opts {"draft":true}');
  });

  it("cuts a long line so a huge argument never reaches the page whole", () => {
    const line = compactArgs({ blob: "x".repeat(1000) });
    expect(line).toHaveLength(240);
    expect(line?.endsWith("…")).toBe(true);
  });

  it("is null for an input that carried nothing (negative)", () => {
    expect(compactArgs(null)).toBeNull();
    expect(compactArgs({})).toBeNull();
    expect(compactArgs({ empty: "", none: {}, list: [] })).toBeNull();
  });
});

describe("callDetail", () => {
  // #3375: a tool entry's request is what the call was made with and its
  // response is what came back. Neither stands in for the other.
  it("reads the input from the request and the result from the response", () => {
    const detail = callDetail({
      name: "Bash",
      family: "shell",
      request: body({ command: "pnpm lint" }),
      response: body({ output: "0 problems" }),
    });
    expect(detail).toMatchObject({
      headline: "pnpm lint",
      output: "0 problems",
    });
  });

  it("reads a response kept as the whole exchange, and prefers the request's input", () => {
    const whole = callDetail({
      name: "Bash",
      family: "shell",
      request: null,
      response: body({ input: { command: "ls" }, output: "a.ts" }),
    });
    expect(whole).toMatchObject({ headline: "ls", output: "a.ts" });
    const both = callDetail({
      name: "Bash",
      family: "shell",
      request: body({ command: "ls -la" }),
      response: body({ input: { command: "ls" }, output: "a.ts" }),
    });
    expect(both).toMatchObject({ headline: "ls -la", output: "a.ts" });
  });

  it("keeps a result that is not JSON as the text it was", () => {
    expect(
      callDetail({
        name: "Bash",
        family: "shell",
        request: body({ command: "echo hi" }),
        response: "hi",
      })?.output,
    ).toBe("hi");
  });

  it("never draws the input as the result when no result came back (negative)", () => {
    const detail = callDetail({
      name: "Bash",
      family: "shell",
      request: body({ command: "sleep 60" }),
      response: null,
    });
    expect(detail?.headline).toBe("sleep 60");
    expect(detail?.output).toBeNull();
  });

  it("takes the tool's name from a body when the record named none", () => {
    expect(
      callDetail({
        name: null,
        family: "shell",
        request: body({ tool_use: { name: "Bash", input: { command: "ls" } } }),
        response: null,
      })?.name,
    ).toBe("Bash");
  });
});
