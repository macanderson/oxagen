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
      const content = Array.from({ length: 50 }, (_, i) => `line ${i}`).join(
        "\n",
      );
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
