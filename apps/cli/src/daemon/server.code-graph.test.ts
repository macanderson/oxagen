/**
 * Daemon code-graph RPC tests — prove the previously-stubbed graph.build /
 * graph.query / graph.search handlers are live end-to-end over the real Unix
 * socket, backed by the persistent CodeGraphStore.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextDaemon } from "./server";
import { DaemonClient } from "./client";

let repo: string;
let dir: string;
let socketPath: string;
let daemon: ContextDaemon;
let client: DaemonClient;

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "oxagen-cgd-repo-"));
  writeFileSync(
    join(repo, "a.ts"),
    "export function alpha() {}\nexport class Beta {}\n",
  );
  dir = mkdtempSync(join(tmpdir(), "oxagen-cgd-dir-"));
  // Keep the socket path short (macOS caps Unix socket paths at ~104 bytes).
  socketPath = join(tmpdir(), `oxcgd${process.pid}.sock`);
  daemon = new ContextDaemon({
    socketPath,
    pidFile: join(dir, "d.pid"),
    logFile: join(dir, "d.log"),
    idleTimeoutMs: 60_000,
    workspaceRoot: repo,
    dbPath: join(dir, "ctx.duckdb"),
    codeGraphDbPath: join(dir, "cg.duckdb"),
  });
  await daemon.start();
  client = new DaemonClient(socketPath);
});

afterEach(async () => {
  await daemon.shutdown();
  rmSync(repo, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
  rmSync(socketPath, { force: true });
});

describe("daemon graph.* handlers", () => {
  it("graph.build indexes + persists the workspace code graph", async () => {
    const res = (await client.buildCodeGraph()) as {
      root: string;
      indexed: number;
      files: number;
      symbols: number;
    };
    expect(res.root).toBe(repo);
    expect(res.indexed).toBe(1);
    expect(res.files).toBe(1);
    expect(res.symbols).toBe(2); // alpha, Beta
  });

  it("graph.search builds on first call (cold) and finds a symbol", async () => {
    const res = (await client.searchCodeGraph("alpha")) as {
      results: Array<{ name: string; kind: string }>;
    };
    expect(res.results.map((r) => r.name)).toContain("alpha");
  });

  it("graph.query returns the neighborhood of a node", async () => {
    const search = (await client.searchCodeGraph("Beta")) as {
      results: Array<{ id: string; name: string }>;
    };
    const beta = search.results.find((r) => r.name === "Beta");
    expect(beta).toBeDefined();

    const neighborhood = (await client.queryCodeGraph(beta!.id, {
      hops: 1,
    })) as {
      nodes: Array<{ name: string; kind: string }>;
    };
    // Beta's only neighbor is its containing file via the `contains` edge.
    expect(
      neighborhood.nodes.some((n) => n.kind === "file" && n.name === "a.ts"),
    ).toBe(true);
  });

  it("a second graph.build is fully incremental (nothing re-parsed)", async () => {
    await client.buildCodeGraph();
    const second = (await client.buildCodeGraph()) as {
      indexed: number;
      skipped: number;
    };
    expect(second).toMatchObject({ indexed: 0, skipped: 1 });
  });
});
