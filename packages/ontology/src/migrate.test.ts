import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
// Stub node:fs so migrate.ts never touches the real filesystem.
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() =>
    [
      "// comment line",
      "CREATE CONSTRAINT a IF NOT EXISTS FOR (n:A) REQUIRE n.id IS UNIQUE;",
      "",
      "CREATE INDEX b IF NOT EXISTS FOR (n:B) ON (n.orgId);",
    ].join("\n"),
  ),
}));

// Stub node:path and node:url — we only need dirname/join/fileURLToPath to
// return deterministic values; the path is passed straight to readFileSync.
vi.mock("node:path", () => ({
  dirname: vi.fn(() => "/stub"),
  join: vi.fn((_dir: string, file: string) => `/stub/${file}`),
}));

vi.mock("node:url", () => ({
  fileURLToPath: vi.fn(() => "/stub/migrate.ts"),
}));

// Stub the client so migrate() never opens a real Neo4j connection.
const runFn = vi.fn(async () => undefined);
const closeFn = vi.fn(async () => undefined);
vi.mock("./client", () => ({
  session: () => ({ run: runFn, close: closeFn }),
  closeDriver: vi.fn(async () => undefined),
}));

import { migrate } from "./migrate";

// ─────────────────────────────────────────────────────────────────────────────

describe("migrate() (@oxagen/ontology)", () => {
  beforeEach(() => {
    runFn.mockClear();
    closeFn.mockClear();
  });

  it("runs one session.run() call per non-empty, non-comment statement", async () => {
    await migrate();
    // The stub schema has 2 real statements (comment + blank filtered out)
    expect(runFn).toHaveBeenCalledTimes(2);
  });

  it("passes each Cypher statement as the first argument to session.run()", async () => {
    await migrate();
    const calls = (runFn.mock.calls as Array<unknown[]>)
      .flatMap((c) => {
        return typeof c[0] === "string" ? [(c[0] as string).trim()] : [];
      });
    expect(calls[0]).toContain("CREATE CONSTRAINT a");
    expect(calls[1]).toContain("CREATE INDEX b");
  });

  it("calls session.close() on success", async () => {
    await migrate();
    expect(closeFn).toHaveBeenCalledTimes(1);
  });

  it("calls session.close() even when session.run() throws", async () => {
    runFn.mockRejectedValueOnce(new Error("Neo4j unavailable"));
    await expect(migrate()).rejects.toThrow("Neo4j unavailable");
    expect(closeFn).toHaveBeenCalledTimes(1);
  });
});

describe("splitStatements (via migrate behaviour)", () => {
  it("strips comment-only lines before splitting", async () => {
    await migrate();
    // If comments were not stripped, runFn would see a comment fragment; it must not.
    const calls = (runFn.mock.calls as Array<unknown[]>)
      .flatMap((c) => {
        return typeof c[0] === "string" ? [c[0] as string] : [];
      });
    for (const stmt of calls) {
      expect(stmt).not.toMatch(/^\s*\/\//);
    }
  });

  it("produces no empty statements", async () => {
    await migrate();
    const calls = (runFn.mock.calls as Array<unknown[]>)
      .flatMap((c) => {
        return typeof c[0] === "string" ? [(c[0] as string).trim()] : [];
      });
    for (const stmt of calls) {
      expect(stmt.length).toBeGreaterThan(0);
    }
  });
});
