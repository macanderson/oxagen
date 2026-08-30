/**
 * Coverage for the edit-integrity wiring in buildWorkspaceTools (docs/specs/
 * unpoisonable-edits): every agent file edit is hash-anchored (a stale anchor is
 * refused, not clobbered), syntax-gated (a new syntax error blocks the write
 * unless declared), and audited (the file-edit event carries the anchor chain +
 * declared-breakage metadata). The pure primitives are covered in
 * edit-integrity.test.ts; here they are exercised through the real tools against
 * a MemoryWorkspace.
 */
import { describe, it, expect } from "vitest";
import { MemoryWorkspace } from "./workspaces/memory";
import { buildWorkspaceTools } from "./tools";
import { hashContent } from "./edit-integrity";
import type { CodingEvent } from "./types";
import type { DiagnosticsProvider } from "./ports";

async function run(tool: unknown, input: unknown): Promise<string> {
  return (
    tool as { execute: (i: unknown, o: unknown) => Promise<string> }
  ).execute(input, {});
}

/** The file-edit events captured from a run, in order. */
type FileEditEvent = Extract<CodingEvent, { type: "file-edit" }>;
function fileEdits(events: CodingEvent[]): FileEditEvent[] {
  return events.filter((e): e is FileEditEvent => e.type === "file-edit");
}

/**
 * A MemoryWorkspace that resolves a relative and an absolute spelling of the
 * same path to ONE stored file, as a real filesystem does. MemoryWorkspace keys
 * files by the literal string, so this is needed to prove the tool-level ledger
 * keys by NORMALIZED path (via resolveDisplayPath) rather than by the exact
 * string the model happened to pass.
 */
class NormalizingWorkspace extends MemoryWorkspace {
  private norm(p: string): string {
    if (p.startsWith("/")) return p;
    const base = this.root.endsWith("/") ? this.root.slice(0, -1) : this.root;
    return `${base}/${p}`;
  }
  override readFile(
    p: string,
    opts?: { offset?: number; limit?: number },
  ): Promise<string> {
    return super.readFile(this.norm(p), opts);
  }
  override writeFile(p: string, content: string): Promise<void> {
    return super.writeFile(this.norm(p), content);
  }
}

describe("edit_file — hash anchoring", () => {
  it("a clean edit after a whole-file read succeeds, returns the anchor chain, and audits before/after hashes + replacements", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "const x = 1;" });
    const events: CodingEvent[] = [];
    const tools = buildWorkspaceTools(ws, { onEvent: (e) => events.push(e) });

    await run(tools.read_file, { path: "a.ts" });
    const result = await run(tools.edit_file, {
      path: "a.ts",
      old_string: "1",
      new_string: "2",
    });

    expect(await ws.readFile("a.ts")).toBe("const x = 2;");
    const before = hashContent("const x = 1;");
    const after = hashContent("const x = 2;");
    expect(result).toContain("(1 replacement)");
    expect(result).toContain(`[anchor ${before} → ${after}]`);

    const [edit] = fileEdits(events);
    expect(edit?.beforeHash).toBe(before);
    expect(edit?.afterHash).toBe(after);
    expect(edit?.replacements).toBe(1);
    expect(edit?.newDiagnostics).toBe(0);
    expect(edit?.declaredBreaking).toBeUndefined();
  });

  it("rejects an edit whose anchor is stale (the file changed on disk since the read) and does NOT clobber it", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "const x = 1;" });
    const tools = buildWorkspaceTools(ws);

    await run(tools.read_file, { path: "a.ts" });
    // Another agent rewrites the file out from under us.
    await ws.writeFile("a.ts", "const x = 99;");

    const result = await run(tools.edit_file, {
      path: "a.ts",
      old_string: "1",
      new_string: "2",
    });

    expect(result).toContain("Stale anchor");
    expect(result).toContain("/repo/a.ts");
    // The tool must NOT have written — the external content stands untouched.
    expect(await ws.readFile("a.ts")).toBe("const x = 99;");
  });

  it("applies an edit that was never preceded by a read (no anchor recorded ⇒ nothing to be stale against)", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "const x = 1;" });
    const tools = buildWorkspaceTools(ws);

    const result = await run(tools.edit_file, {
      path: "a.ts",
      old_string: "1",
      new_string: "2",
    });

    expect(result).toContain("Edited");
    expect(await ws.readFile("a.ts")).toBe("const x = 2;");
  });

  it("a ranged read does NOT record an anchor, so a later edit is not blocked by an external change", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "const x = 1;\nconst y = 2;" });
    const tools = buildWorkspaceTools(ws);

    // Ranged read (offset/limit) — sees only a slice, cannot vouch for the whole file.
    await run(tools.read_file, { path: "a.ts", offset: 1, limit: 1 });
    await ws.writeFile("a.ts", "const x = 1;\nconst y = 3;");

    const result = await run(tools.edit_file, {
      path: "a.ts",
      old_string: "3",
      new_string: "4",
    });

    expect(result).toContain("Edited");
    expect(await ws.readFile("a.ts")).toBe("const x = 1;\nconst y = 4;");
  });

  it("consecutive edits without a re-read chain correctly (each edit re-pins the anchor)", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "const x = 1;" });
    const tools = buildWorkspaceTools(ws);

    await run(tools.read_file, { path: "a.ts" });
    const first = await run(tools.edit_file, {
      path: "a.ts",
      old_string: "1",
      new_string: "2",
    });
    // No re-read: this only succeeds if the FIRST edit updated the ledger to the
    // hash of "const x = 2;" (otherwise the anchor would be stale here).
    const second = await run(tools.edit_file, {
      path: "a.ts",
      old_string: "2",
      new_string: "3",
    });

    expect(first).toContain("Edited");
    expect(second).toContain("Edited");
    expect(second).not.toContain("Stale anchor");
    expect(await ws.readFile("a.ts")).toBe("const x = 3;");
  });
});

describe("edit_file — syntax gate", () => {
  it("rejects a syntax-breaking edit on a .ts file, lists the error, and leaves the file unchanged", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "const x = 1;" });
    const tools = buildWorkspaceTools(ws);

    const result = await run(tools.edit_file, {
      path: "a.ts",
      old_string: "1;",
      new_string: "(",
    });

    expect(result).toContain("Edit rejected");
    expect(result).toContain("Expression expected");
    expect(result).toContain("expect_errors:true");
    // Not written.
    expect(await ws.readFile("a.ts")).toBe("const x = 1;");
  });

  it("lets the same breaking edit through under expect_errors:true and records the declared breakage", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "const x = 1;" });
    const events: CodingEvent[] = [];
    const tools = buildWorkspaceTools(ws, { onEvent: (e) => events.push(e) });

    const result = await run(tools.edit_file, {
      path: "a.ts",
      old_string: "1;",
      new_string: "(",
      expect_errors: true,
    });

    expect(result).toContain("Edited");
    expect(result).toContain("DECLARED BREAKING");
    expect(await ws.readFile("a.ts")).toBe("const x = (");

    const [edit] = fileEdits(events);
    expect(edit?.declaredBreaking).toBe(true);
    expect(edit?.newDiagnostics).toBeGreaterThan(0);
  });

  it("passes an edit to an ALREADY-broken file that introduces no new error (only NEW damage gates)", async () => {
    // Line 1 is already unparseable; the edit only touches line 2, so the gate
    // must not block it — the pre-existing error is not this edit's fault.
    const ws = new MemoryWorkspace({ "a.ts": "const x = (\nconst y = 1;" });
    const tools = buildWorkspaceTools(ws);

    const result = await run(tools.edit_file, {
      path: "a.ts",
      old_string: "1;",
      new_string: "2;",
    });

    expect(result).toContain("Edited");
    expect(result).not.toContain("Edit rejected");
    expect(await ws.readFile("a.ts")).toBe("const x = (\nconst y = 2;");
  });

  it("does not gate a non-code file (unsupported extension)", async () => {
    const ws = new MemoryWorkspace({ "notes.md": "# hi" });
    const tools = buildWorkspaceTools(ws);
    // '<not valid code' would be a syntax error IF this were checked — it is not,
    // because .md is unsupported.
    const result = await run(tools.edit_file, {
      path: "notes.md",
      old_string: "# hi",
      new_string: "# hi <not valid ( code",
    });
    expect(result).toContain("Edited");
    expect(await ws.readFile("notes.md")).toBe("# hi <not valid ( code");
  });
});

describe("write_file — anchoring + syntax gate", () => {
  it("rejects creating a file with invalid .ts content, and allows it under expect_errors", async () => {
    const ws = new MemoryWorkspace({});
    const events: CodingEvent[] = [];
    const tools = buildWorkspaceTools(ws, { onEvent: (e) => events.push(e) });

    const rejected = await run(tools.write_file, {
      path: "new.ts",
      content: "const x = (",
    });
    expect(rejected).toContain("Edit rejected");
    await expect(ws.readFile("new.ts")).rejects.toThrow();

    const allowed = await run(tools.write_file, {
      path: "new.ts",
      content: "const x = (",
      expect_errors: true,
    });
    expect(allowed).toContain("Wrote");
    expect(allowed).toContain("DECLARED BREAKING");
    expect(await ws.readFile("new.ts")).toBe("const x = (");

    const [create] = fileEdits(events);
    expect(create?.kind).toBe("create");
    expect(create?.beforeHash).toBeUndefined();
    expect(create?.declaredBreaking).toBe(true);
  });

  it("rejects a blind clobber of a file that changed on disk since it was read (stale anchor)", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "const x = 1;" });
    const tools = buildWorkspaceTools(ws);

    await run(tools.read_file, { path: "a.ts" });
    await ws.writeFile("a.ts", "const x = 99;"); // external change

    const result = await run(tools.write_file, {
      path: "a.ts",
      content: "const x = 2;",
    });

    expect(result).toContain("Stale anchor");
    expect(await ws.readFile("a.ts")).toBe("const x = 99;");
  });

  it("a clean overwrite after a read returns the anchor chain and audits before/after hashes", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "const x = 1;" });
    const events: CodingEvent[] = [];
    const tools = buildWorkspaceTools(ws, { onEvent: (e) => events.push(e) });

    await run(tools.read_file, { path: "a.ts" });
    const result = await run(tools.write_file, {
      path: "a.ts",
      content: "const x = 2;",
    });

    const before = hashContent("const x = 1;");
    const after = hashContent("const x = 2;");
    expect(result).toBe(
      `Wrote 12 bytes to /repo/a.ts [anchor ${before} → ${after}]`,
    );
    const [edit] = fileEdits(events);
    expect(edit?.kind).toBe("update");
    expect(edit?.beforeHash).toBe(before);
    expect(edit?.afterHash).toBe(after);
  });
});

describe("edit gate — optional DiagnosticsProvider", () => {
  const provider: DiagnosticsProvider = {
    // Flags any content containing the marker BAD — stands in for a tsserver that
    // sees a cross-file reference the single-file syntax check cannot.
    diagnostics: async (_path, content) => ({
      errors: content.includes("BAD") ? ["diag: unresolved reference"] : [],
    }),
  };

  it("blocks an edit that introduces a NEW provider diagnostic even when the syntax is valid", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "const x = 1;" });
    const tools = buildWorkspaceTools(ws, { diagnostics: provider });

    const result = await run(tools.edit_file, {
      path: "a.ts",
      old_string: "1",
      new_string: "1 /* BAD */",
    });

    expect(result).toContain("Edit rejected");
    expect(result).toContain("diag: unresolved reference");
    expect(await ws.readFile("a.ts")).toBe("const x = 1;");
  });

  it("allows an edit the provider does not flag", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "const x = 1;" });
    const tools = buildWorkspaceTools(ws, { diagnostics: provider });

    const result = await run(tools.edit_file, {
      path: "a.ts",
      old_string: "1",
      new_string: "2",
    });
    expect(result).toContain("Edited");
    expect(await ws.readFile("a.ts")).toBe("const x = 2;");
  });

  it("fails open when the diagnostics provider throws (a broken server never wedges an edit)", async () => {
    const throwing: DiagnosticsProvider = {
      diagnostics: async () => {
        throw new Error("tsserver crashed");
      },
    };
    const ws = new MemoryWorkspace({ "a.ts": "const x = 1;" });
    const tools = buildWorkspaceTools(ws, { diagnostics: throwing });

    const result = await run(tools.edit_file, {
      path: "a.ts",
      old_string: "1",
      new_string: "2",
    });
    expect(result).toContain("Edited");
    expect(await ws.readFile("a.ts")).toBe("const x = 2;");
  });
});

describe("edit_file — replace_all miss", () => {
  it("rejects a replace_all whose old_string matches nothing, with corrective feedback and no write", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "const x = 1;" });
    const tools = buildWorkspaceTools(ws);

    const result = await run(tools.edit_file, {
      path: "a.ts",
      old_string: "zzz",
      new_string: "yyy",
      replace_all: true,
    });

    // Hits the occurrences===0 branch of the replace_all arm: a not-found miss is
    // still an error even for replace_all, and it must NOT write.
    expect(result).toContain("Error editing a.ts");
    expect(result).toContain("not found");
    expect(await ws.readFile("a.ts")).toBe("const x = 1;");
  });
});

describe("write_file — overwrite without a preceding read + create audit", () => {
  it("overwrites an existing file with NO preceding read (no ledger entry ⇒ stale check skipped) and returns the anchor chain", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "const x = 1;" });
    const events: CodingEvent[] = [];
    const tools = buildWorkspaceTools(ws, { onEvent: (e) => events.push(e) });

    // No read_file first — the ledger has no entry, so the stale-anchor guard is
    // skipped and the overwrite proceeds.
    const result = await run(tools.write_file, {
      path: "a.ts",
      content: "const x = 2;",
    });

    const before = hashContent("const x = 1;");
    const after = hashContent("const x = 2;");
    expect(result).toBe(
      `Wrote 12 bytes to /repo/a.ts [anchor ${before} → ${after}]`,
    );
    expect(await ws.readFile("a.ts")).toBe("const x = 2;");

    const [edit] = fileEdits(events);
    expect(edit?.kind).toBe("update");
    expect(edit?.beforeHash).toBe(before);
    expect(edit?.afterHash).toBe(after);
  });

  it("records newDiagnostics > 0 on a create that ships declared breakage under expect_errors", async () => {
    const ws = new MemoryWorkspace({});
    const events: CodingEvent[] = [];
    const tools = buildWorkspaceTools(ws, { onEvent: (e) => events.push(e) });

    const result = await run(tools.write_file, {
      path: "new.ts",
      content: "const x = (",
      expect_errors: true,
    });

    expect(result).toContain("Wrote");
    const [create] = fileEdits(events);
    expect(create?.kind).toBe("create");
    expect(create?.declaredBreaking).toBe(true);
    expect(create?.newDiagnostics).toBeGreaterThan(0);
  });
});

describe("write_file — optional DiagnosticsProvider", () => {
  it("blocks a write that introduces a NEW provider diagnostic, and fails open when the provider throws", async () => {
    // Blocking provider: flags any content containing the marker BAD.
    const blocking: DiagnosticsProvider = {
      diagnostics: async (_path, content) => ({
        errors: content.includes("BAD") ? ["diag: unresolved reference"] : [],
      }),
    };
    const wsBlocked = new MemoryWorkspace({ "a.ts": "const x = 1;" });
    const blockedTools = buildWorkspaceTools(wsBlocked, {
      diagnostics: blocking,
    });
    const blocked = await run(blockedTools.write_file, {
      path: "a.ts",
      content: "const x = 1; /* BAD */",
    });
    expect(blocked).toContain("Edit rejected");
    expect(blocked).toContain("diag: unresolved reference");
    expect(await wsBlocked.readFile("a.ts")).toBe("const x = 1;");

    // Throwing provider: the write must still land (fail-open on the optional source).
    const throwing: DiagnosticsProvider = {
      diagnostics: async () => {
        throw new Error("tsserver crashed");
      },
    };
    const wsOpen = new MemoryWorkspace({ "a.ts": "const x = 1;" });
    const openTools = buildWorkspaceTools(wsOpen, { diagnostics: throwing });
    const ok = await run(openTools.write_file, {
      path: "a.ts",
      content: "const x = 2;",
    });
    expect(ok).toContain("Wrote");
    expect(await wsOpen.readFile("a.ts")).toBe("const x = 2;");
  });
});

describe("edit gate — ledger key normalization (tool level)", () => {
  it("shares one ledger entry across relative and absolute spellings, so a stale anchor is detected via either", async () => {
    const ws = new NormalizingWorkspace({ "/repo/a.ts": "const x = 1;" });
    const tools = buildWorkspaceTools(ws);

    // Read via the RELATIVE spelling — the anchor is recorded under the
    // normalized key (resolveDisplayPath("/repo", "a.ts") === "/repo/a.ts").
    await run(tools.read_file, { path: "a.ts" });
    // Another writer changes the file (same underlying file via normalization).
    await ws.writeFile("a.ts", "const x = 99;");

    // Edit via the ABSOLUTE spelling — it must resolve to the SAME ledger entry
    // and therefore see the stale anchor. If the two spellings keyed separately,
    // the absolute edit would find no entry and clobber the file.
    const result = await run(tools.edit_file, {
      path: "/repo/a.ts",
      old_string: "99",
      new_string: "2",
    });

    expect(result).toContain("Stale anchor");
    expect(await ws.readFile("a.ts")).toBe("const x = 99;");
  });
});
