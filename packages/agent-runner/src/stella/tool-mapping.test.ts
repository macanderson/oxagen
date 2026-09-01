/**
 * Tool advertisement and dispatch.
 *
 * Two of these tests guard properties whose failure is silent in production:
 * a tool set that reaches the model with `execute` still attached runs every
 * call twice (once by the SDK, once by the engine asking the host), and a
 * mutating tool advertised as `read_only` is one the engine will happily
 * dispatch concurrently with another write.
 */
import { describe, expect, test, vi } from "vitest";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BUILTIN_MUTATING_TOOLS,
  executeToolRequest,
  mutatingToolSet,
  renderToolResult,
  toModelToolSet,
  toToolSchemas,
  UnknownToolError,
} from "./tool-mapping";
import { MUTATING_TOOL_NAMES } from "@oxagen/agent-engine";

/** Explicitly two-arg so `mock.calls` is typed as the SDK actually calls it. */
type ToolExec = (input: unknown, options: unknown) => Promise<string>;

function fixtureTools(execute: ToolExec = async () => "ok"): ToolSet {
  return {
    read_file: tool({
      description: "Read a file",
      inputSchema: z.object({ path: z.string() }),
      execute,
    }),
    write_file: tool({
      description: "Write a file",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute,
    }),
    deploy: tool({
      description: "A capability tool the host classified as mutating",
      inputSchema: z.object({}),
      execute,
    }),
  };
}

describe("BUILTIN_MUTATING_TOOLS", () => {
  test("is the engine's list itself, not a copy of it", () => {
    // This used to be a mirrored literal pinned to the engine's by a test that
    // read `loop-driver.ts` off disk and regex-scraped it. The engine's copy
    // moved to `tools-shared.ts` and is exported, so the two cannot diverge and
    // there is nothing to scrape.
    //
    // The hazard that test guarded still explains why this matters: a tool the
    // engine fences and this list does not is advertised to Stella as
    // `read_only`, and Stella then dispatches it concurrently with another
    // write — a data race with no error anywhere.
    expect([...BUILTIN_MUTATING_TOOLS].sort()).toEqual(
      [...MUTATING_TOOL_NAMES].sort(),
    );
    expect([...BUILTIN_MUTATING_TOOLS].sort()).toEqual([
      "bash",
      "delete_file",
      "edit_file",
      "write_file",
    ]);
  });
});

describe("mutatingToolSet", () => {
  test("unions the caller's list with the built-in workspace mutators", () => {
    const set = mutatingToolSet(["deploy"]);
    for (const name of BUILTIN_MUTATING_TOOLS) expect(set.has(name)).toBe(true);
    expect(set.has("deploy")).toBe(true);
    expect(set.has("read_file")).toBe(false);
  });

  test("no caller list still fences the built-ins", () => {
    expect(mutatingToolSet(undefined).has("bash")).toBe(true);
  });
});

describe("toToolSchemas", () => {
  test("read_only is the inverse of the host's mutating classification", async () => {
    const schemas = await toToolSchemas(
      fixtureTools(),
      mutatingToolSet(["deploy"]),
    );
    const byName = Object.fromEntries(schemas.map((s) => [s.name, s]));
    expect(byName.read_file!.read_only).toBe(true);
    expect(byName.write_file!.read_only).toBe(false);
    // This is the whole bridge for macanderson/oxagen#1234: the list that fed
    // the TS dispatch guard now feeds the engine's own partitioning.
    expect(byName.deploy!.read_only).toBe(false);
  });

  test("carries a real JSON Schema the model can call against", async () => {
    const [readFile] = await toToolSchemas(
      { read_file: fixtureTools().read_file! },
      mutatingToolSet([]),
    );
    expect(readFile!.input_schema).toMatchObject({
      type: "object",
      properties: { path: { type: "string" } },
    });
  });

  test("advertises every registered tool, description or not", async () => {
    const schemas = await toToolSchemas(
      {
        nameless: tool({ inputSchema: z.object({}), execute: async () => "" }),
      },
      mutatingToolSet([]),
    );
    expect(schemas).toHaveLength(1);
    expect(schemas[0]!.description).toBe("");
  });
});

describe("toModelToolSet", () => {
  test("strips execute so the SDK cannot run the tool itself", () => {
    // Without this the SDK runs the call AND the engine asks the host to run
    // it — one `bash` becoming two, with nothing downstream reporting it.
    const stripped = toModelToolSet(fixtureTools());
    for (const entry of Object.values(stripped)) {
      expect(entry).not.toHaveProperty("execute");
    }
  });

  test("keeps the schema and description the model needs", () => {
    const stripped = toModelToolSet(fixtureTools());
    expect(Object.keys(stripped)).toEqual([
      "read_file",
      "write_file",
      "deploy",
    ]);
    expect(stripped.read_file!.description).toBe("Read a file");
    expect(stripped.read_file!.inputSchema).toBeDefined();
  });

  test("leaves the original set executable", () => {
    const tools = fixtureTools();
    toModelToolSet(tools);
    expect(tools.read_file!.execute).toBeTypeOf("function");
  });
});

describe("executeToolRequest", () => {
  const context = { toolCallId: "c1" };

  test("runs the host's real tool and wraps the result in the ok arm", async () => {
    const execute = vi.fn<ToolExec>(async () => "file contents");
    const output = await executeToolRequest(
      fixtureTools(execute),
      "read_file",
      { path: "a.ts" },
      context,
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toEqual({ path: "a.ts" });
    expect(output).toEqual({ ok: { content: "file contents" } });
  });

  test("a thrown tool becomes the error arm, not a rejection", async () => {
    // Tool failure is ordinary: the engine hands the message to the model as
    // text it can react to.
    const tools = fixtureTools(
      vi.fn<ToolExec>(async () => {
        throw new Error("permission denied");
      }),
    );
    await expect(
      executeToolRequest(tools, "write_file", {}, context),
    ).resolves.toEqual({ error: { message: "permission denied" } });
  });

  test("an unregistered tool is a contract break, and throws", async () => {
    await expect(
      executeToolRequest(fixtureTools(), "not_a_tool", {}, context),
    ).rejects.toThrow(UnknownToolError);
  });

  test("forwards the turn's abort signal to the tool", async () => {
    const controller = new AbortController();
    const execute = vi.fn<ToolExec>(async () => "");
    await executeToolRequest(
      fixtureTools(execute),
      "read_file",
      {},
      {
        toolCallId: "c1",
        signal: controller.signal,
      },
    );
    expect(
      (execute.mock.calls[0]![1] as { abortSignal?: AbortSignal }).abortSignal,
    ).toBe(controller.signal);
  });
});

describe("renderToolResult", () => {
  test("a string passes through unquoted", () => {
    // JSON-quoting would show the model escape sequences instead of contents.
    expect(renderToolResult("line one\nline two")).toBe("line one\nline two");
  });

  test("an object is JSON", () => {
    expect(renderToolResult({ ok: 1 })).toBe('{"ok":1}');
  });

  test("undefined is empty, and a cycle degrades instead of throwing", () => {
    expect(renderToolResult(undefined)).toBe("");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => renderToolResult(cyclic)).not.toThrow();
  });
});
