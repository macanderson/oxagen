import { describe, expect, it } from "vitest";
import {
  groupOf,
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

describe("groupOf", () => {
  it("groups by name, whatever its case", () => {
    expect(groupOf("Bash")).toBe("shell");
    expect(groupOf("bash")).toBe("shell");
    expect(groupOf("Read")).toBe("read");
    expect(groupOf("Edit")).toBe("edit");
    expect(groupOf("MultiEdit")).toBe("edit");
    expect(groupOf("Write")).toBe("create");
    expect(groupOf("Grep")).toBe("search");
    expect(groupOf("Glob")).toBe("search");
    expect(groupOf("WebFetch")).toBe("web");
    expect(groupOf("Skill")).toBe("skill");
    expect(groupOf("Task")).toBe("agent");
    expect(groupOf("TodoWrite")).toBe("plan");
  });

  it("puts every MCP tool in the mcp group whatever it is called", () => {
    expect(groupOf("mcp__github__list_issues")).toBe("mcp");
    expect(groupOf("mcp__anything__read")).toBe("mcp");
  });

  it("falls back to the generic group", () => {
    expect(groupOf("SomethingNobodyKnows")).toBe("tool");
    expect(groupOf("")).toBe("tool");
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

  it("groups a prefixed tool by its own name, and an MCP tool as MCP", () => {
    expect(groupOf("claude_code__Bash")).toBe("shell");
    expect(groupOf("write_file")).toBe("create");
    expect(groupOf("mcp__github__get_file_contents")).toBe("mcp");
  });
});

describe("toolDetail", () => {
  it("returns null when nothing names the tool", () => {
    expect(toolDetail(null, null)).toBeNull();
    expect(toolDetail(null, body({ input: { command: "ls" } }))).toBeNull();
  });

  it("takes the name from the body when the frame carried none", () => {
    const detail = toolDetail(
      null,
      body({ tool_use: { name: "Bash", input: { command: "ls -la" } } }),
    );
    expect(detail?.name).toBe("Bash");
    expect(detail?.headline).toBe("ls -la");
  });

  it("reads a value already parsed the same way (a model's tool_use block)", () => {
    expect(
      toolDetailOf("Grep", { input: { pattern: "TODO", path: "/repo/src" } }),
    ).toMatchObject({ headline: "TODO", detail: "in /repo/src" });
  });

  describe("shell", () => {
    it("heads the line with the command and keeps the command whole as the call", () => {
      const detail = toolDetail(
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
      const detail = toolDetail(
        "Bash",
        body({ input: { command: "cd app\npnpm test" } }),
      );
      expect(detail?.headline).toBe("cd app");
      expect(detail?.multiline).toBe(true);
      expect(detail?.raw).toBe("cd app\npnpm test");
    });

    it("falls back to the description when no command was recorded", () => {
      const detail = toolDetail(
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
      toolDetail("Bash", body({ input: { command: "x" }, output }))?.output;

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
      const detail = toolDetail(
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
        toolDetail("Read", body({ input: { file_path: "a.ts", offset: 4 } }))
          ?.detail,
      ).toBe("lines 5+");
      expect(
        toolDetail("Read", body({ input: { file_path: "a.ts" } }))?.detail,
      ).toBeNull();
    });

    it("leaves the headline empty when the body recorded no path", () => {
      expect(toolDetail("Read", body({ input: {} }))?.headline).toBeNull();
    });

    it("reads a delete the same way it reads a read", () => {
      expect(
        toolDetail("rm", body({ input: { path: "/repo/tmp/x.log" } })),
      ).toMatchObject({ group: "delete", headline: "…/tmp/x.log" });
    });
  });

  describe("edit", () => {
    it("draws the change as a diff against the file it changed", () => {
      const detail = toolDetail(
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
      const detail = toolDetail(
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
      const detail = toolDetail(
        "Edit",
        body({ input: { file_path: "a.ts", new_string: "added" } }),
      );
      expect(detail?.diffs[0]?.diff).toMatchObject({ added: 1, removed: 0 });
    });

    it("draws nothing for an edit that recorded neither side, and says when no path was recorded", () => {
      expect(
        toolDetail("Edit", body({ input: { file_path: "a.ts" } }))?.diffs,
      ).toEqual([]);
      expect(
        toolDetail(
          "Edit",
          body({ input: { old_string: "a", new_string: "b" } }),
        )?.diffs[0]?.path,
      ).toBe("(no path recorded)");
    });

    it("reads a notebook edit as an edit", () => {
      const detail = toolDetail(
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
      const detail = toolDetail(
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
        toolDetail("Write", body({ input: { file_path: "a.ts" } }))?.diffs,
      ).toEqual([]);
    });
  });

  describe("a search, a fetch, a skill, a subagent and a plan", () => {
    it("heads a search with its pattern and says where it looked", () => {
      expect(
        toolDetail(
          "Grep",
          body({ input: { pattern: "TODO", path: "/r/a/src" } }),
        ),
      ).toMatchObject({
        group: "search",
        headline: "TODO",
        detail: "in …/a/src",
      });
      expect(
        toolDetail("Glob", body({ input: { pattern: "**/*.ts" } })),
      ).toMatchObject({ headline: "**/*.ts", detail: null });
    });

    it("heads a fetch with its URL, and keeps what it was asked in the call", () => {
      const detail = toolDetail(
        "WebFetch",
        body({ input: { url: "https://x.dev", prompt: "Summarize" } }),
      );
      expect(detail?.headline).toBe("https://x.dev");
      expect(detail?.raw).toContain('"prompt": "Summarize"');
    });

    it("prints a skill's version once, and only when the record carried one", () => {
      expect(
        toolDetail(
          "Skill",
          body({ input: { skill: "file-inbox", version: "v1.2" } }),
        ),
      ).toMatchObject({
        group: "skill",
        headline: "file-inbox",
        detail: "v1.2",
      });
      expect(
        toolDetail("Skill", body({ input: { skill: "file-inbox" } }))?.detail,
      ).toBeNull();
    });

    it("names a subagent by what it was asked to do, and credits its type beside it", () => {
      expect(
        toolDetail(
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
        toolDetail("Task", body({ input: { subagent_type: "Explore" } })),
      ).toMatchObject({ headline: "Explore", detail: null });
    });

    it("counts a plan's items, or reads its first line when it is prose", () => {
      expect(
        toolDetail("TodoWrite", body({ input: { todos: [{}, {}, {}] } }))
          ?.headline,
      ).toBe("3 items");
      expect(
        toolDetail(
          "ExitPlanMode",
          body({ input: { plan: "Step one\nStep two" } }),
        )?.headline,
      ).toBe("Step one");
    });
  });

  describe("a tool with no shape of its own", () => {
    it("heads the line with its arguments in order, the first bare and the rest by name", () => {
      const detail = toolDetail(
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
      const detail = toolDetail(
        "run_query",
        body({ input: { sql: "select 1\nfrom t" } }),
      );
      expect(detail?.headline).toBe("select 1");
      expect(detail?.multiline).toBe(true);
    });

    it("has no headline and no call for an input that carried nothing (negative)", () => {
      const detail = toolDetail("run_query", body({ input: {} }));
      expect(detail?.headline).toBeNull();
      expect(detail?.raw).toBeNull();
    });
  });
});
