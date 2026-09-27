import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  encodingIssues,
  readJsonLines,
  readTomlFile,
  schemaIssues,
} from "./files";

const directive = "#:schema https://oxagen.sh/schemas/agent/v1.json";

const agentSchema = z
  .object({
    name: z.string(),
    tags: z.array(z.string()).optional(),
    limits: z.object({ max: z.number() }).strict().optional(),
    items: z.array(z.object({ id: z.string() }).strict()).optional(),
    model: z
      .object({ provider: z.object({ id: z.string() }).strict() })
      .strict()
      .optional(),
  })
  .strict();

const lineSchema = z
  .object({ id: z.string(), n: z.number().optional() })
  .strict();

function toml(...lines: string[]): string {
  return `${[directive, ...lines].join("\n")}\n`;
}

function zodError(schema: z.ZodTypeAny, value: unknown): z.ZodError {
  const result = schema.safeParse(value);
  if (result.success) throw new Error("expected the value to fail");
  return result.error;
}

describe("encodingIssues", () => {
  it("accepts UTF-8 text with LF endings and a final newline", () => {
    expect(encodingIssues("a = 1\nb = 2\n")).toEqual([]);
  });

  it("reports an empty file and nothing else", () => {
    expect(encodingIssues("")).toEqual([
      { line: null, field: null, message: "the file is empty" },
    ]);
  });

  it("reports a byte-order mark on line 1", () => {
    expect(encodingIssues("﻿a = 1\n")).toEqual([
      {
        line: 1,
        field: null,
        message:
          "the file starts with a byte-order mark. Save it as UTF-8 without one.",
      },
    ]);
  });

  it("reports CRLF on the line of the first carriage return", () => {
    expect(encodingIssues("a = 1\nb = 2\r\nc = 3\r\n")).toEqual([
      { line: 2, field: null, message: "the file has CRLF line endings. Use LF." },
    ]);
  });

  it("reports a missing final newline on the last line", () => {
    expect(encodingIssues("a = 1\nb = 2")).toEqual([
      { line: 2, field: null, message: "the file does not end with a newline" },
    ]);
  });

  it("reports every rule a file breaks, in order", () => {
    expect(
      encodingIssues("﻿a\r\nb").map((issue) => [issue.line, issue.message]),
    ).toEqual([
      [
        1,
        "the file starts with a byte-order mark. Save it as UTF-8 without one.",
      ],
      [1, "the file has CRLF line endings. Use LF."],
      [2, "the file does not end with a newline"],
    ]);
  });
});

describe("schemaIssues", () => {
  it("gives no line when no lookup is passed", () => {
    expect(schemaIssues(zodError(agentSchema, {}))).toEqual([
      { line: null, field: "name", message: "Required" },
    ]);
  });

  it("asks the lookup for the line of a top-level field", () => {
    const lines: string[] = [];
    const lineOf = (field: string): number => {
      lines.push(field);
      return 7;
    };
    expect(
      schemaIssues(zodError(agentSchema, { name: "x", limits: {} }), lineOf),
    ).toEqual([{ line: 7, field: "limits.max", message: "Required" }]);
    expect(lines).toEqual(["limits"]);
  });

  it("gives no line or field for an issue on the value itself", () => {
    expect(schemaIssues(zodError(z.string(), 1), () => 7)).toEqual([
      { line: null, field: null, message: "Expected string, received number" },
    ]);
  });

  it("gives no line when the path starts at an array index", () => {
    expect(schemaIssues(zodError(z.array(z.string()), [1]), () => 7)).toEqual([
      { line: null, field: "0", message: "Expected string, received number" },
    ]);
  });

  it("gives no line for an unknown key inside an array item", () => {
    const schema = z.array(z.object({ id: z.string() }).strict());
    expect(
      schemaIssues(zodError(schema, [{ id: "a", extra: 1 }]), () => 7),
    ).toEqual([
      {
        line: null,
        field: "0.extra",
        message: "extra is not a known field. Remove it or check its spelling.",
      },
    ]);
  });
});

describe("readTomlFile", () => {
  it("returns the parsed value of a good file", () => {
    expect(
      readTomlFile(toml('name = "x"', 'tags = ["a"]'), "agent/v1", agentSchema),
    ).toEqual({ ok: true, value: { name: "x", tags: ["a"] } });
  });

  it("stops at the encoding issues", () => {
    expect(readTomlFile("", "agent/v1", agentSchema)).toEqual({
      ok: false,
      issues: [{ line: null, field: null, message: "the file is empty" }],
    });
    const noNewline = `${directive}\nname = "x"`;
    expect(readTomlFile(noNewline, "agent/v1", agentSchema)).toEqual({
      ok: false,
      issues: [
        {
          line: 2,
          field: null,
          message: "the file does not end with a newline",
        },
      ],
    });
  });

  it("refuses a first line that names another schema", () => {
    const text =
      '#:schema https://oxagen.sh/schemas/workspace/v1.json\nname = "x"\n';
    expect(readTomlFile(text, "agent/v1", agentSchema)).toEqual({
      ok: false,
      issues: [
        {
          line: 1,
          field: null,
          message:
            "the first line must be #:schema https://oxagen.sh/schemas/agent/v1.json",
        },
      ],
    });
  });

  it("reports a TOML parse error on its line, with the first message line", () => {
    const result = readTomlFile(toml("name"), "agent/v1", agentSchema);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(1);
    const [issue] = result.issues;
    expect(issue?.line).toBe(2);
    expect(issue?.field).toBeNull();
    expect(issue?.message).toMatch(
      /^the file is not TOML: Invalid TOML document: /,
    );
    expect(issue?.message).not.toContain("\n");
  });

  it("gives no line for a parse error that carries none", async () => {
    vi.resetModules();
    vi.doMock("smol-toml", () => ({
      parse: () => {
        throw new Error("boom\nsecond line");
      },
    }));
    try {
      const { readTomlFile: read } = await import("./files");
      expect(read(toml('name = "x"'), "agent/v1", agentSchema)).toEqual({
        ok: false,
        issues: [
          { line: null, field: null, message: "the file is not TOML: boom" },
        ],
      });
    } finally {
      vi.doUnmock("smol-toml");
      vi.resetModules();
    }
  });

  it.each([
    ["key = value", toml("name = 1"), 2, "name"],
    ["key=value", toml("name=1"), 2, "name"],
    [
      "[table]",
      toml('name = "x"', "", "[limits]", 'max = "big"'),
      4,
      "limits.max",
    ],
    [
      "[[array of tables]]",
      toml('name = "x"', "", "[[items]]", "id = 1"),
      4,
      "items.0.id",
    ],
    [
      "[dotted.table]",
      toml('name = "x"', "", "[model.provider]", "id = 1"),
      4,
      "model.provider.id",
    ],
  ])("finds the line of a field written as %s", (_form, text, line, field) => {
    const result = readTomlFile(text, "agent/v1", agentSchema);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      expect.objectContaining({ line, field }),
    ]);
  });

  it("gives no line for a missing top-level field", () => {
    expect(
      readTomlFile(toml("tags = []"), "agent/v1", agentSchema),
    ).toEqual({
      ok: false,
      issues: [{ line: null, field: "name", message: "Required" }],
    });
  });

  it("reports an unknown top-level key on its own line", () => {
    const result = readTomlFile(
      toml('name = "x"', "extra = 1"),
      "agent/v1",
      agentSchema,
    );
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          line: 3,
          field: "extra",
          message: "extra is not a known field. Remove it or check its spelling.",
        },
      ],
    });
  });

  it("reports each unknown key as its own issue", () => {
    const result = readTomlFile(
      toml('name = "x"', "first = 1", "second = 2"),
      "agent/v1",
      agentSchema,
    );
    expect(result).toEqual({
      ok: false,
      issues: [
        expect.objectContaining({ line: 3, field: "first" }),
        expect.objectContaining({ line: 4, field: "second" }),
      ],
    });
  });

  it("reports an unknown key in a table on the table's header line", () => {
    const result = readTomlFile(
      toml('name = "x"', "", "[limits]", "max = 1", "extra = 2"),
      "agent/v1",
      agentSchema,
    );
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          line: 4,
          field: "limits.extra",
          message: "extra is not a known field. Remove it or check its spelling.",
        },
      ],
    });
  });
});

describe("readJsonLines", () => {
  it("returns every line of a good file", () => {
    expect(
      readJsonLines('{"id":"a"}\n{"id":"b","n":2}\n', lineSchema),
    ).toEqual({ ok: true, value: [{ id: "a" }, { id: "b", n: 2 }] });
  });

  it("stops at the encoding issues", () => {
    expect(readJsonLines('{"id":"a"}', lineSchema)).toEqual({
      ok: false,
      issues: [
        {
          line: 1,
          field: null,
          message: "the file does not end with a newline",
        },
      ],
    });
  });

  it.each([
    ["text that is not JSON", '{"id":"a"}\nnot json\n'],
    ["a blank line", '{"id":"a"}\n\n'],
  ])("reports %s as a bad line", (_name, text) => {
    expect(readJsonLines(text, lineSchema)).toEqual({
      ok: false,
      issues: [
        { line: 2, field: null, message: "the line is not one JSON object" },
      ],
    });
  });

  it("reports a line that holds JSON but not an object", () => {
    expect(readJsonLines('{"id":"a"}\n[1]\n', lineSchema)).toEqual({
      ok: false,
      issues: [
        { line: 2, field: null, message: "Expected object, received array" },
      ],
    });
  });

  it("reports a schema issue on the line it came from", () => {
    expect(readJsonLines('{"id":"a"}\n{"id":1}\n', lineSchema)).toEqual({
      ok: false,
      issues: [
        { line: 2, field: "id", message: "Expected string, received number" },
      ],
    });
  });

  it("reports the issues of every line", () => {
    const result = readJsonLines('nope\n{"id":"a"}\n{"id":1}\n', lineSchema);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.line)).toEqual([1, 3]);
  });
});
