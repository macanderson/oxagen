/**
 * The client is tested against a real child process, not a mocked `spawn`,
 * because the two facts it is built around are facts about processes: that
 * `app-server` exits on stdin EOF before answering, and that answers arrive
 * as newline-framed JSON interleaved with notifications. A mock would agree
 * with whatever the client did.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexAppServerClient } from "./codex-app-server";

/** A stand-in `codex` on disk: a node script run as `<script> app-server`. */
function fakeCodex(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tacho-appserver-"));
  const path = join(dir, "codex.mjs");
  writeFileSync(
    path,
    `import { createInterface } from "node:readline";
const say = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const lines = createInterface({ input: process.stdin });
${body}
`,
  );
  return path;
}

/**
 * The real client always sends `app-server` as the only argument, so the
 * fake is invoked through a shell shim that ignores it and runs the script.
 */
function shimFor(body: string): string {
  const script = fakeCodex(body);
  const dir = mkdtempSync(join(tmpdir(), "tacho-appserver-shim-"));
  const shim = join(dir, "codex");
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`, {
    mode: 0o755,
  });
  return shim;
}

const ECHO = `lines.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "initialize") return say({ jsonrpc: "2.0", id: m.id, result: { ok: true } });
  say({ jsonrpc: "2.0", method: "log", params: { text: "chatter" } });
  say({ jsonrpc: "2.0", id: m.id, result: { echoed: m.method } });
});`;

describe("codex app-server client", () => {
  it("answers every request in order and ignores notifications", async () => {
    const client = codexAppServerClient({
      binary: shimFor(ECHO),
      cwd: tmpdir(),
      env: process.env,
      timeoutMs: 10_000,
    });
    const result = await client([
      { method: "hooks/list", params: { cwds: [] } },
      { method: "config/value/write", params: { keyPath: "hooks.state" } },
    ]);
    expect(result.problem).toBeUndefined();
    expect(result.answers).toEqual([
      { result: { echoed: "hooks/list" } },
      { result: { echoed: "config/value/write" } },
    ]);
  });

  it("keeps a JSON-RPC error as an error rather than an empty answer", async () => {
    const client = codexAppServerClient({
      binary: shimFor(`lines.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "initialize") return say({ jsonrpc: "2.0", id: m.id, result: {} });
  say({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unknown method" } });
});`),
      cwd: tmpdir(),
      env: process.env,
      timeoutMs: 10_000,
    });
    const result = await client([{ method: "hooks/list" }]);
    expect(result.answers[0]?.error?.message).toBe("unknown method");
    expect(result.problem).toBeUndefined();
  });

  it("returns one empty answer per request when the server exits saying nothing", async () => {
    const client = codexAppServerClient({
      binary: shimFor(`lines.on("line", () => process.exit(0));`),
      cwd: tmpdir(),
      env: process.env,
      timeoutMs: 10_000,
    });
    const result = await client([
      { method: "hooks/list" },
      { method: "config/value/write" },
    ]);
    expect(result.answers).toEqual([{}, {}]);
  });

  it("gives up on a server that never answers, instead of hanging the command it is part of", async () => {
    const client = codexAppServerClient({
      binary: shimFor(`lines.on("line", () => {});`),
      cwd: tmpdir(),
      env: process.env,
      timeoutMs: 300,
    });
    const result = await client([{ method: "hooks/list" }]);
    expect(result.problem).toContain("did not answer in time");
    expect(result.answers).toHaveLength(1);
  });

  it("reports a missing binary rather than throwing", async () => {
    const client = codexAppServerClient({
      binary: join(tmpdir(), "definitely-not-a-codex-binary"),
      cwd: tmpdir(),
      env: process.env,
      timeoutMs: 5_000,
    });
    const result = await client([{ method: "hooks/list" }]);
    expect(result.problem).toContain("could not run");
  });

  it("spawns nothing when there is nothing to ask", async () => {
    // The binary does not exist: reaching spawn at all would be the failure.
    const client = codexAppServerClient({
      binary: join(tmpdir(), "definitely-not-a-codex-binary"),
      cwd: tmpdir(),
      env: process.env,
    });
    expect(await client([])).toEqual({ answers: [] });
  });
});

describe("Codex RPC ordering", () => {
  it("waits for initialization and each write before asking for its readback", async () => {
    const client = codexAppServerClient({
      binary: shimFor(`let ready = false;
let notified = false;
let written = false;
lines.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") return setTimeout(() => { ready = true; say({ id: m.id, result: {} }); }, 20);
  if (m.method === "initialized") { notified = true; return; }
  if (!ready || !notified) return say({ id: m.id, error: { message: "not initialized" } });
  if (m.method === "config/value/write") return setTimeout(() => { written = true; say({ id: m.id, result: {} }); }, 20);
  say({ id: m.id, result: { written } });
});`),
      cwd: tmpdir(),
      env: process.env,
      timeoutMs: 5_000,
    });
    const result = await client([
      { method: "config/value/write" },
      { method: "hooks/list" },
    ]);
    expect(result.problem).toBeUndefined();
    expect(result.answers).toEqual([
      { result: {} },
      { result: { written: true } },
    ]);
  });

  it("reports initialization rejection without sending a trust write", async () => {
    const client = codexAppServerClient({
      binary: shimFor(`lines.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") return say({ id: m.id, error: { message: "unsupported" } });
  say({ id: m.id, result: { unexpectedWrite: true } });
});`),
      cwd: tmpdir(),
      env: process.env,
      timeoutMs: 5_000,
    });
    const result = await client([{ method: "config/value/write" }]);
    expect(result.problem).toContain("refused initialization");
    expect(result.answers).toEqual([{}]);
  });
});
