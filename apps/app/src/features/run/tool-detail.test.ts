import { describe, expect, it } from "vitest";
import {
  CREATE_PREVIEW,
  groupOf,
  OUTPUT_PREVIEW,
  parseBody,
  shortPath,
  splitBody,
  type ToolPane,
  toolDetail,
} from "./tool-detail";

/** The body as the recorder writes it: JSON, on one line. */
function body(value: unknown): string {
  return JSON.stringify(value);
}

function panes(detail: { panes: ToolPane[] } | null): ToolPane[] {
  return detail?.panes ?? [];
}

function pane(
  detail: { panes: ToolPane[] } | null,
  label: string,
): ToolPane | undefined {
  return panes(detail).find((each) => each.label === label);
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

describe("toolDetail", () => {
  it("returns null when nothing names the tool", () => {
    expect(toolDetail(null, null)).toBeNull();
    expect(toolDetail(null, body({ input: { command: "ls" } }))).toBeNull();
  });

  it("takes the name from the body when the frame carried none", () => {
    const detail = toolDetail(
      null,
      body({ tool_use: { name: "Skill", input: { skill: "file-inbox" } } }),
    );
    expect(detail?.name).toBe("Skill");
    expect(detail?.group).toBe("skill");
  });

  describe("shell", () => {
    it("heads the line with the command and opens its pane whole", () => {
      const detail = toolDetail(
        "Bash",
        body({ input: { command: "git status" } }),
      );
      expect(detail?.headline).toBe("git status");
      expect(detail?.multiline).toBe(false);
      // A one-line command has nothing folded, so the surface draws no
      // control over it.
      expect(pane(detail, "command")).toMatchObject({
        kind: "code",
        language: "shell",
        preview: null,
      });
    });

    it("heads a multiline command with its first line and folds the rest", () => {
      const detail = toolDetail(
        "Bash",
        body({ input: { command: "cd /tmp\nls -la\nexit" } }),
      );
      expect(detail?.headline).toBe("cd /tmp");
      expect(detail?.multiline).toBe(true);
      expect(pane(detail, "command")).toMatchObject({ preview: 1 });
    });

    it("shows the output to a budget", () => {
      const detail = toolDetail(
        "Bash",
        body({ input: { command: "ls" }, output: { stdout: "a\nb\nc" } }),
      );
      expect(pane(detail, "output")).toMatchObject({
        kind: "code",
        text: "a\nb\nc",
        preview: OUTPUT_PREVIEW,
      });
    });

    it("joins stdout and stderr in the order they are read", () => {
      const detail = toolDetail(
        "Bash",
        body({
          input: { command: "ls" },
          output: { stdout: "out", stderr: "err" },
        }),
      );
      expect(pane(detail, "output")).toMatchObject({ text: "out\nerr" });
    });

    it("falls back to the description when no command was recorded", () => {
      const detail = toolDetail(
        "Bash",
        body({ input: { description: "List the files" } }),
      );
      expect(detail?.headline).toBe("List the files");
      expect(panes(detail)).toHaveLength(0);
    });
  });

  describe("read", () => {
    it("heads the line with the file and says which lines were read", () => {
      const detail = toolDetail(
        "Read",
        body({
          input: { file_path: "/a/b/c/kernel.ts", offset: 10, limit: 20 },
        }),
      );
      expect(detail?.headline).toBe("…/c/kernel.ts");
      expect(detail?.detail).toBe("lines 11–30");
      expect(panes(detail)).toHaveLength(0);
    });

    it("says nothing about the range when none was recorded", () => {
      const detail = toolDetail("Read", body({ input: { file_path: "a.ts" } }));
      expect(detail?.detail).toBeNull();
    });
  });

  describe("edit", () => {
    it("shows the change as a diff against the file it changed", () => {
      const detail = toolDetail(
        "Edit",
        body({
          input: {
            file_path: "/a/b/c/kernel.ts",
            old_string: "const a = 1;",
            new_string: "const a = 2;",
          },
        }),
      );
      expect(detail?.headline).toBe("…/c/kernel.ts");
      expect(detail?.detail).toBe("+1 −1");
      const diff = pane(detail, "diff");
      expect(diff).toMatchObject({ kind: "diff", path: "/a/b/c/kernel.ts" });
      expect(diff?.kind === "diff" ? diff.diff.added : null).toBe(1);
    });

    it("gives a MultiEdit one diff per replacement, in order", () => {
      const detail = toolDetail(
        "MultiEdit",
        body({
          input: {
            file_path: "a.ts",
            edits: [
              { old_string: "one", new_string: "1" },
              { old_string: "two", new_string: "2" },
            ],
          },
        }),
      );
      expect(panes(detail)).toHaveLength(2);
      expect(detail?.detail).toBe("+2 −2");
    });

    it("draws no diff when the body recorded neither side", () => {
      const detail = toolDetail("Edit", body({ input: { file_path: "a.ts" } }));
      expect(panes(detail)).toHaveLength(0);
      expect(detail?.detail).toBeNull();
    });
  });

  describe("create", () => {
    it("shows the file's first lines and counts them", () => {
      const content = Array.from(
        { length: 50 },
        (_, i) => `line ${String(i)}`,
      ).join("\n");
      const detail = toolDetail(
        "Write",
        body({ input: { file_path: "notes.json", content } }),
      );
      expect(detail?.detail).toBe("50 lines");
      expect(pane(detail, "contents")).toMatchObject({
        kind: "code",
        language: "json",
        preview: CREATE_PREVIEW,
      });
    });
  });

  describe("search", () => {
    it("heads the line with the pattern and says where it looked", () => {
      const detail = toolDetail(
        "Grep",
        body({
          input: { pattern: "registerCapability", path: "/a/b/packages" },
        }),
      );
      expect(detail?.headline).toBe("registerCapability");
      expect(detail?.detail).toBe("in …/b/packages");
    });

    it("reads a Glob's pattern too", () => {
      const detail = toolDetail(
        "Glob",
        body({ input: { pattern: "**/*.ts" } }),
      );
      expect(detail?.headline).toBe("**/*.ts");
      expect(detail?.detail).toBeNull();
    });
  });

  describe("skill", () => {
    it("reads the skill out of the tool_use body rather than print the JSON", () => {
      const detail = toolDetail(
        "Skill",
        body({
          tool_use: {
            id: "toolu_01DNFJYYTP8NQUgeyyimi6tK",
            name: "Skill",
            input: { skill: "file-inbox" },
          },
        }),
      );
      expect(detail?.group).toBe("skill");
      expect(detail?.headline).toBe("file-inbox");
      expect(panes(detail)).toHaveLength(0);
    });

    it("shows a version only when the record carried one", () => {
      expect(
        toolDetail("Skill", body({ input: { skill: "x" } }))?.detail,
      ).toBeNull();
      expect(
        toolDetail("Skill", body({ input: { skill: "x", version: "1.2.3" } }))
          ?.detail,
      ).toBe("v1.2.3");
      // A producer that already wrote the `v` must not get two of them.
      expect(
        toolDetail("Skill", body({ input: { skill: "x", version: "v1.2.3" } }))
          ?.detail,
      ).toBe("v1.2.3");
    });
  });

  describe("web", () => {
    it("heads the line with the URL and keeps the prompt as a note", () => {
      const detail = toolDetail(
        "WebFetch",
        body({
          input: { url: "https://example.com", prompt: "What changed?" },
        }),
      );
      expect(detail?.headline).toBe("https://example.com");
      expect(pane(detail, "asked")).toMatchObject({
        kind: "note",
        text: "What changed?",
      });
    });
  });

  describe("agent", () => {
    it("names what the subagent was asked to do and which one it was", () => {
      const detail = toolDetail(
        "Task",
        body({
          input: {
            description: "Audit the routes",
            subagent_type: "Explore",
            prompt: "Find every route file",
          },
        }),
      );
      expect(detail?.headline).toBe("Audit the routes");
      expect(detail?.detail).toBe("Explore");
      expect(pane(detail, "brief")).toMatchObject({ kind: "note" });
    });
  });

  describe("plan", () => {
    it("counts the items a TodoWrite carried", () => {
      const detail = toolDetail(
        "TodoWrite",
        body({ input: { todos: [{ content: "a" }, { content: "b" }] } }),
      );
      expect(detail?.headline).toBe("2 items");
    });
  });

  describe("an unknown tool", () => {
    it("still reads, with its input as formatted JSON rather than one line", () => {
      const detail = toolDetail(
        "SomethingNew",
        body({ input: { target: "the thing" }, output: { ok: true } }),
      );
      expect(detail?.group).toBe("tool");
      expect(detail?.headline).toBe("the thing");
      const input = pane(detail, "input");
      expect(input).toMatchObject({ kind: "code", language: "json" });
      // Formatted, so it reads as source and not as a wall of escapes.
      expect(input?.kind === "code" ? input.text : "").toContain("\n");
    });

    it("names an MCP tool by its tool and credits its server", () => {
      const detail = toolDetail(
        "mcp__github__list_issues",
        body({ input: { owner: "macanderson" } }),
      );
      expect(detail?.name).toBe("list_issues");
      expect(detail?.detail).toBe("github");
      expect(detail?.group).toBe("mcp");
    });

    it("draws no pane for an input that carried nothing", () => {
      expect(
        panes(toolDetail("SomethingNew", body({ input: {} }))),
      ).toHaveLength(0);
      expect(panes(toolDetail("SomethingNew", null))).toHaveLength(0);
    });
  });
});

// The shapes a recorder writes that the cases above do not reach: an output
// that is a bare string or carries only stderr, an input the body spelled as
// something other than an object, and the per-tool readings for a delete, a
// notebook edit, a skill, a sub-agent and a plan.
describe("toolDetail, the rest of the recorded shapes", () => {
  describe("a command's output", () => {
    it("reads an output the recorder wrote as a bare string", () => {
      const detail = toolDetail(
        "Bash",
        body({ input: { command: "ls" }, output: "two files\n" }),
      );
      expect(pane(detail, "output")?.kind).toBe("code");
      expect(pane(detail, "output")).toMatchObject({ text: "two files\n" });
    });

    it("draws no output pane for an empty string", () => {
      expect(
        pane(
          toolDetail("Bash", body({ input: { command: "ls" }, output: "" })),
          "output",
        ),
      ).toBeUndefined();
    });

    it("reads stderr on its own", () => {
      const detail = toolDetail(
        "Bash",
        body({ input: { command: "ls" }, output: { stderr: "no such file" } }),
      );
      expect(pane(detail, "output")).toMatchObject({ text: "no such file" });
    });

    it("joins stdout and stderr in that order", () => {
      const detail = toolDetail(
        "Bash",
        body({
          input: { command: "ls" },
          output: { stdout: "out", stderr: "err" },
        }),
      );
      expect(pane(detail, "output")).toMatchObject({ text: "out\nerr" });
    });

    it("falls back to whichever text key the producer used", () => {
      const detail = toolDetail(
        "Bash",
        body({ input: { command: "ls" }, output: { message: "done" } }),
      );
      expect(pane(detail, "output")).toMatchObject({ text: "done" });
    });

    it("draws no output pane for an object that carried no text at all", () => {
      expect(
        pane(
          toolDetail(
            "Bash",
            body({ input: { command: "ls" }, output: { code: 0 } }),
          ),
          "output",
        ),
      ).toBeUndefined();
    });
  });

  describe("a command with no command in it", () => {
    it("falls back to the description and leaves the qualifier empty", () => {
      const detail = toolDetail(
        "Bash",
        body({ input: { description: "List the tree" } }),
      );
      expect(detail?.headline).toBe("List the tree");
      expect(detail?.detail).toBeNull();
      expect(panes(detail)).toHaveLength(0);
    });

    it("opens a multi-line command at the line the headline showed", () => {
      const detail = toolDetail(
        "Bash",
        body({ input: { command: "set -e\nmake gate" } }),
      );
      expect(detail?.headline).toBe("set -e");
      expect(detail?.multiline).toBe(true);
      expect(pane(detail, "command")).toMatchObject({ preview: 1 });
    });
  });

  describe("an input the body spelled some other way", () => {
    it("treats a non-object input as no input", () => {
      expect(splitBody({ input: "ls -la" }).input).toBeNull();
      expect(
        splitBody({ tool_use: { name: "Read", input: "x" } }).input,
      ).toBeNull();
    });

    it("reads a content block's name and its result", () => {
      expect(
        splitBody({ tool_use: { name: "Read", input: { file_path: "a.ts" } } }),
      ).toMatchObject({
        name: "Read",
        output: null,
      });
      expect(
        splitBody({ tool_use: { name: "Read" }, tool_result: "ok" }).output,
      ).toBe("ok");
    });

    it("leaves the output null when the body carried only an input", () => {
      expect(splitBody({ input: { file_path: "a.ts" } }).output).toBeNull();
    });

    it("names an MCP tool that carried no tool half by its whole name", () => {
      const detail = toolDetail("mcp__github", body({ input: {} }));
      expect(detail?.name).toBe("mcp__github");
      expect(detail?.detail).toBeNull();
      expect(detail?.group).toBe("mcp");
    });
  });

  describe("a read", () => {
    it("says the line range the call asked for", () => {
      expect(
        toolDetail(
          "Read",
          body({ input: { file_path: "a.ts", offset: 3, limit: 20 } }),
        )?.detail,
      ).toBe("lines 4–23");
      expect(
        toolDetail("Read", body({ input: { file_path: "a.ts", offset: 3 } }))
          ?.detail,
      ).toBe("lines 4+");
      expect(
        toolDetail("Read", body({ input: { file_path: "a.ts", limit: 20 } }))
          ?.detail,
      ).toBe("lines 1–20");
      expect(
        toolDetail("Read", body({ input: { file_path: "a.ts" } }))?.detail,
      ).toBeNull();
    });

    it("leaves the headline empty when the body recorded no path", () => {
      expect(toolDetail("Read", body({ input: {} }))?.headline).toBeNull();
    });

    it("reads a delete the same way it reads a read", () => {
      const detail = toolDetail(
        "rm",
        body({ input: { file_path: "src/old/gone.ts" } }),
      );
      expect(detail?.group).toBe("delete");
      expect(detail?.headline).toBe("…/old/gone.ts");
    });
  });

  describe("an edit", () => {
    it("draws one diff per replacement and skips an entry that is not one", () => {
      const detail = toolDetail(
        "MultiEdit",
        body({
          input: {
            file_path: "src/a.ts",
            edits: ["junk", { oldString: "one", newString: "two" }, {}],
          },
        }),
      );
      expect(panes(detail)).toHaveLength(2);
      expect(detail?.detail).toBe("+1 −1");
    });

    it("records a one-sided replacement as the diff it is", () => {
      const detail = toolDetail(
        "Edit",
        body({ input: { file_path: "src/a.ts", new_string: "added" } }),
      );
      expect(panes(detail)).toHaveLength(1);
      expect(detail?.detail).toBe("+1 −0");
    });

    it("draws nothing for an edit that recorded neither side", () => {
      const detail = toolDetail(
        "Edit",
        body({ input: { file_path: "src/a.ts" } }),
      );
      expect(panes(detail)).toHaveLength(0);
      expect(detail?.detail).toBeNull();
    });

    it("says so when the body recorded no path at all", () => {
      expect(
        toolDetail(
          "Edit",
          body({ input: { old_string: "a", new_string: "b" } }),
        )?.headline,
      ).toBe("(no path recorded)");
    });

    it("reads a notebook edit as an edit", () => {
      const detail = toolDetail(
        "NotebookEdit",
        body({ input: { notebook_path: "run/a.ipynb", new_string: "x" } }),
      );
      expect(detail?.group).toBe("notebook");
      expect(pane(detail, "diff")?.kind).toBe("diff");
    });
  });

  describe("a create", () => {
    it("paints the contents in the language the path names and counts its lines", () => {
      const detail = toolDetail(
        "Write",
        body({ input: { file_path: "conf/a.json", content: "{\n}\n" } }),
      );
      expect(pane(detail, "contents")).toMatchObject({
        language: "json",
        preview: CREATE_PREVIEW,
      });
      expect(detail?.detail).toBe("3 lines");
    });

    it("falls back to plain text when the body recorded no path", () => {
      const detail = toolDetail("Write", body({ input: { content: "hello" } }));
      expect(detail?.headline).toBeNull();
      expect(pane(detail, "contents")).toMatchObject({ language: "text" });
    });

    it("draws no pane for a create that recorded no contents", () => {
      const detail = toolDetail(
        "Write",
        body({ input: { file_path: "conf/a.json" } }),
      );
      expect(panes(detail)).toHaveLength(0);
      expect(detail?.detail).toBeNull();
    });
  });

  describe("a search, a fetch, a skill, a sub-agent and a plan", () => {
    it("says where a search looked, and nothing when it did not say", () => {
      expect(
        toolDetail(
          "Grep",
          body({ input: { pattern: "todo", include: "src/run" } }),
        )?.detail,
      ).toBe("in src/run");
      expect(
        toolDetail("Grep", body({ input: { pattern: "todo" } }))?.detail,
      ).toBeNull();
    });

    it("keeps what a fetch was asked, and draws nothing when it was asked nothing", () => {
      expect(
        pane(
          toolDetail(
            "WebFetch",
            body({ input: { url: "https://x.test", prompt: "the price" } }),
          ),
          "asked",
        ),
      ).toMatchObject({ text: "the price" });
      expect(
        panes(
          toolDetail("WebFetch", body({ input: { url: "https://x.test" } })),
        ),
      ).toHaveLength(0);
    });

    it("prints a skill version once, however the body spelled it", () => {
      expect(
        toolDetail(
          "Skill",
          body({ input: { skill: "clear-prose", version: "v2.1" } }),
        )?.detail,
      ).toBe("v2.1");
      expect(
        toolDetail(
          "Skill",
          body({ input: { skill: "clear-prose", skill_version: "3" } }),
        )?.detail,
      ).toBe("v3");
      expect(
        toolDetail("Skill", body({ input: { skill: "clear-prose" } }))?.detail,
      ).toBeNull();
      expect(
        pane(
          toolDetail(
            "Skill",
            body({ input: { skill: "clear-prose", args: "--check" } }),
          ),
          "arguments",
        ),
      ).toMatchObject({ text: "--check" });
    });

    it("names a sub-agent by what it was asked to do, and credits its type beside it", () => {
      const both = toolDetail(
        "Task",
        body({
          input: { subagent_type: "explore", description: "Find the caller" },
        }),
      );
      expect(both?.headline).toBe("Find the caller");
      expect(both?.detail).toBe("explore");

      const typeOnly = toolDetail(
        "Task",
        body({ input: { agent_type: "explore" } }),
      );
      expect(typeOnly?.headline).toBe("explore");
      expect(typeOnly?.detail).toBeNull();

      expect(
        pane(
          toolDetail("Task", body({ input: { prompt: "Read the log" } })),
          "brief",
        ),
      ).toMatchObject({
        text: "Read the log",
      });
    });

    it("counts a plan's items, or reads its first line when it is prose", () => {
      expect(
        toolDetail("TodoWrite", body({ input: { todos: [{}, {}, {}] } }))
          ?.headline,
      ).toBe("3 items");
      const prose = toolDetail(
        "ExitPlanMode",
        body({ input: { plan: "Split the file\nThen test it" } }),
      );
      expect(prose?.headline).toBe("Split the file");
      expect(pane(prose, "plan")?.kind).toBe("note");
      expect(toolDetail("TodoWrite", body({ input: {} }))?.headline).toBeNull();
    });
  });

  describe("a tool with no shape of its own", () => {
    it("prints the input and the output as formatted JSON", () => {
      const detail = toolDetail(
        "SomethingNew",
        body({ input: { note: "hi" }, output: { ok: true } }),
      );
      expect(pane(detail, "input")).toMatchObject({
        language: "json",
        preview: OUTPUT_PREVIEW,
      });
      expect(pane(detail, "output")?.kind).toBe("code");
      expect(detail?.headline).toBe("hi");
    });

    it("reads a multi-line first value as the first line of something longer", () => {
      const detail = toolDetail(
        "SomethingNew",
        body({ input: { note: "first\nsecond" } }),
      );
      expect(detail?.headline).toBe("first");
      expect(detail?.multiline).toBe(true);
    });
  });
});
