/**
 * Coverage for the un-poisonable-edits guard as wired through
 * buildWorkspaceTools: read_file anchors a content hash, edit_file denies on
 * drift (stale read) and on syntax regressions, write_file denies content
 * that would newly break a file — all BEFORE anything touches the workspace.
 * See guard/edit-guard.ts for the guard itself (tested in isolation in
 * guard/edit-guard.test.ts); this file covers the tools.ts wiring.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { MemoryWorkspace } from "./workspaces/memory";
import { buildWorkspaceTools } from "./tools";
import {
  staleFileDeniedMessage,
  syntaxRegressionDeniedMessage,
} from "./guard/edit-guard";

const VALID_TS = `export function add(a: number, b: number): number {\n  return a + b;\n}\n`;
const BROKEN_TS = `export function add(a: number, b: number): number {\n  return a + b;\n`;

async function run(tool: unknown, input: unknown): Promise<string> {
  return (tool as { execute: (i: unknown, o: unknown) => Promise<string> }).execute(
    input,
    {},
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("edit_file — stale-read hash anchor", () => {
  it("denies the edit when the file drifted after read_file, leaving it untouched", async () => {
    const ws = new MemoryWorkspace({ "a.ts": VALID_TS });
    const tools = buildWorkspaceTools(ws);
    await run(tools["read_file"], { path: "a.ts" });
    // Out-of-band drift: a formatter, a parallel session, or a bash command.
    const drifted = VALID_TS + "// drifted\n";
    await ws.writeFile("a.ts", drifted);
    const result = await run(tools["edit_file"], {
      path: "a.ts",
      old_string: "return a + b;",
      new_string: "return b + a;",
    });
    expect(result).toBe(staleFileDeniedMessage("a.ts"));
    expect(await ws.readFile("a.ts")).toBe(drifted);
  });

  it("allows the edit and refreshes the anchor for chained edits", async () => {
    const ws = new MemoryWorkspace({ "a.ts": VALID_TS });
    const tools = buildWorkspaceTools(ws);
    await run(tools["read_file"], { path: "a.ts" });
    const first = await run(tools["edit_file"], {
      path: "a.ts",
      old_string: "return a + b;",
      new_string: "return b + a;",
    });
    expect(first).toContain("Edited");
    const second = await run(tools["edit_file"], {
      path: "a.ts",
      old_string: "return b + a;",
      new_string: "return a + b;",
    });
    expect(second).toContain("Edited");
    expect(await ws.readFile("a.ts")).toBe(VALID_TS);
  });

  it("does not gate a file that was never read", async () => {
    const ws = new MemoryWorkspace({ "a.ts": VALID_TS });
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools["edit_file"], {
      path: "a.ts",
      old_string: "a + b",
      new_string: "b + a",
    });
    expect(result).toContain("Edited");
  });

  it("write_file re-anchors, so an immediate follow-up edit passes", async () => {
    const ws = new MemoryWorkspace();
    const tools = buildWorkspaceTools(ws);
    await run(tools["write_file"], { path: "n.ts", content: VALID_TS });
    const result = await run(tools["edit_file"], {
      path: "n.ts",
      old_string: "a + b",
      new_string: "b + a",
    });
    expect(result).toContain("Edited");
  });

  it("is disabled via the editGuard option", async () => {
    const ws = new MemoryWorkspace({ "a.ts": VALID_TS });
    const tools = buildWorkspaceTools(ws, {
      editGuard: { hashGuard: false, syntaxGuard: false },
    });
    await run(tools["read_file"], { path: "a.ts" });
    await ws.writeFile("a.ts", VALID_TS + "// drifted\n");
    const result = await run(tools["edit_file"], {
      path: "a.ts",
      old_string: "// drifted",
      new_string: "// changed",
    });
    expect(result).toContain("Edited");
  });
});

describe("edit_file — syntax-regression gate", () => {
  it("denies an edit that would introduce a syntax error, before any write", async () => {
    const ws = new MemoryWorkspace({ "a.ts": VALID_TS });
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools["edit_file"], {
      path: "a.ts",
      old_string: "return a + b;\n}",
      new_string: "return a + b;",
    });
    expect(result).toContain("new syntax error");
    expect(await ws.readFile("a.ts")).toBe(VALID_TS);
  });

  it("honors allow_syntax_errors for intentional breakage", async () => {
    const ws = new MemoryWorkspace({ "a.ts": VALID_TS });
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools["edit_file"], {
      path: "a.ts",
      old_string: "return a + b;\n}",
      new_string: "return a + b;",
      allow_syntax_errors: true,
    });
    expect(result).toContain("Edited");
  });

  it("still surfaces the native corrective error for a missing old_string", async () => {
    const ws = new MemoryWorkspace({ "a.ts": VALID_TS });
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools["edit_file"], {
      path: "a.ts",
      old_string: "not in the file",
      new_string: "x",
    });
    expect(result).toContain("Error editing a.ts");
  });

  it("is disabled via the OXAGEN_EDIT_SYNTAX_GUARD kill switch", async () => {
    vi.stubEnv("OXAGEN_EDIT_SYNTAX_GUARD", "0");
    const ws = new MemoryWorkspace({ "a.ts": VALID_TS });
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools["edit_file"], {
      path: "a.ts",
      old_string: "return a + b;\n}",
      new_string: "return a + b;",
    });
    expect(result).toContain("Edited");
  });
});

describe("write_file — syntax-regression gate", () => {
  it("denies creating a new file that does not parse", async () => {
    const ws = new MemoryWorkspace();
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools["write_file"], {
      path: "fresh.ts",
      content: BROKEN_TS,
    });
    expect(result).toContain("new syntax error");
    await expect(ws.readFile("fresh.ts")).rejects.toThrow();
  });

  it("writes the file when allow_syntax_errors is declared", async () => {
    const ws = new MemoryWorkspace();
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools["write_file"], {
      path: "fixture.ts",
      content: BROKEN_TS,
      allow_syntax_errors: true,
    });
    expect(result).toContain("Wrote");
    expect(await ws.readFile("fixture.ts")).toBe(BROKEN_TS);
  });

  it("allows overwriting an already-broken file with no-worse content", async () => {
    const ws = new MemoryWorkspace({ "b.ts": BROKEN_TS });
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools["write_file"], {
      path: "b.ts",
      content: VALID_TS,
    });
    expect(result).toContain("Wrote");
  });

  it("does not gate non-code files", async () => {
    const ws = new MemoryWorkspace();
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools["write_file"], {
      path: "notes.md",
      content: "# unbalanced ( { [",
    });
    expect(result).toContain("Wrote");
  });

  it("names the first introduced error in the denial", async () => {
    const ws = new MemoryWorkspace();
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools["write_file"], {
      path: "one.ts",
      content: "const x = {;\n",
    });
    // Exact message shape is owned by syntaxRegressionDeniedMessage — assert
    // the wiring passes its parts through rather than re-deriving the count.
    expect(result).toContain("Blocked:");
    expect(result).toContain("one.ts");
    expect(result).toMatch(/first: line \d+:/);
    expect(result).toBe(
      syntaxRegressionDeniedMessage(
        "one.ts",
        Number(/introduce (\d+) new/.exec(result)?.[1] ?? "0"),
        /first: (line \d+: [^)]+)\)/.exec(result)?.[1],
      ),
    );
  });
});
