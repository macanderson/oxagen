import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

// ── Mocks ────────────────────────────────────────────────────────────────────
// Keep the real WORKSPACE_ROOT / isSafeWorkspacePath; only toggle availability.
const h = vi.hoisted(() => ({
  available: true,
  startFn: vi.fn(),
  stopFn: vi.fn(),
  execFn: vi.fn(),
}));

vi.mock("@oxagen/sandbox", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/sandbox")>();
  return { ...real, isSandboxAvailable: () => h.available };
});
// The workspace wraps its handler calls in runInTenantScope; make it a
// pass-through so the test's non-UUID fixture ctx doesn't trip UUID validation.
vi.mock("@oxagen/tenancy", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/tenancy")>();
  return {
    ...real,
    runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
  };
});
vi.mock("../handlers/agent.sandbox.start", () => ({
  agentSandboxStartHandler: h.startFn,
}));
vi.mock("../handlers/agent.sandbox.exec", () => ({
  agentSandboxExecHandler: h.execFn,
}));
vi.mock("../handlers/agent.sandbox.stop", () => ({
  agentSandboxStopHandler: h.stopFn,
}));

import {
  ModalSandboxWorkspace,
  SandboxWorkspaceUnavailableError,
} from "./sandbox-workspace";

// A tiny in-memory FS + shell interpreter for the exact command shapes the
// workspace emits, so write→read round-trips exercise the base64 framing.
const FS = new Map<string, string>();
let changedList: string[] = [];

function ok(stdout: string) {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    executionMs: 1,
    timedOut: false,
    restored: false,
  };
}
function fail() {
  return {
    exitCode: 1,
    stdout: "",
    stderr: "no such file",
    executionMs: 1,
    timedOut: false,
    restored: false,
  };
}

function interpret(input: { command: string; stdin?: string }) {
  const cmd = input.command;
  // write: mkdir … && base64 -d > '<abs>'
  const w = cmd.match(/base64 -d > '([^']+)'/);
  if (w) {
    FS.set(w[1]!, Buffer.from(input.stdin ?? "", "base64").toString("utf8"));
    return ok("");
  }
  // read: base64 '<abs>'  (no -d)
  const r = cmd.match(/^base64 '([^']+)'$/);
  if (r) {
    const content = FS.get(r[1]!);
    if (content === undefined) return fail();
    return ok(Buffer.from(content, "utf8").toString("base64"));
  }
  if (cmd.includes("--name-only --diff-filter=d"))
    return ok(changedList.join("\n"));
  if (cmd.includes("find . -type f")) {
    const rels = [...FS.keys()].map((k) => k.replace("/work/", ""));
    return ok(rels.join("\n"));
  }
  return ok("");
}

beforeEach(() => {
  h.available = true;
  FS.clear();
  changedList = [];
  h.startFn.mockReset().mockResolvedValue({
    sessionId: "sbx_1",
    status: "running",
    image: "agent",
    createdAt: "2026-07-06T00:00:00.000Z",
    reused: false,
  });
  h.stopFn.mockReset().mockResolvedValue({ stopped: true });
  h.execFn.mockReset().mockImplementation(async (input) => interpret(input));
});

describe("ModalSandboxWorkspace", () => {
  it("throws a typed error (not a stub success) when no driver is available", async () => {
    h.available = false;
    const ws = new ModalSandboxWorkspace({ ctx: CTX, sessionKey: "k1" });
    await expect(ws.readFile("a.ts")).rejects.toBeInstanceOf(
      SandboxWorkspaceUnavailableError,
    );
    expect(h.startFn).not.toHaveBeenCalled();
  });

  it("starts the session once and reuses it across ops (start-by-key)", async () => {
    const ws = new ModalSandboxWorkspace({ ctx: CTX, sessionKey: "conv-42" });
    await ws.writeFile("a.ts", "one");
    await ws.readFile("a.ts");
    await ws.exec("pnpm test");
    expect(h.startFn).toHaveBeenCalledTimes(1);
    expect(h.startFn.mock.calls[0]![0]).toMatchObject({
      sessionKey: "conv-42",
      image: "agent",
    });
  });

  it("passes environmentId through to the session start", async () => {
    const ws = new ModalSandboxWorkspace({
      ctx: CTX,
      sessionKey: "k",
      environmentId: "env_9",
    });
    await ws.exec("ls");
    expect(h.startFn.mock.calls[0]![0]).toMatchObject({
      environmentId: "env_9",
    });
  });

  it("round-trips file writes through base64 framing (write then read)", async () => {
    const ws = new ModalSandboxWorkspace({ ctx: CTX, sessionKey: "k" });
    const body = "line1\nline2\n\tπ tab\n";
    await ws.writeFile("src/x.ts", body);
    expect(await ws.readFile("src/x.ts")).toBe(body);
    // write command must carry content via stdin, never in the command line.
    const writeCall = h.execFn.mock.calls.find((c) =>
      c[0].command.includes("base64 -d >"),
    )!;
    expect(writeCall[0].command).not.toContain(body);
    expect(Buffer.from(writeCall[0].stdin, "base64").toString("utf8")).toBe(
      body,
    );
  });

  it("readFile honors offset/limit slicing", async () => {
    const ws = new ModalSandboxWorkspace({ ctx: CTX, sessionKey: "k" });
    await ws.writeFile("f.txt", "a\nb\nc\nd\n");
    expect(await ws.readFile("f.txt", { offset: 2, limit: 2 })).toBe("b\nc");
  });

  it("readFile throws ENOENT for a missing file", async () => {
    const ws = new ModalSandboxWorkspace({ ctx: CTX, sessionKey: "k" });
    await expect(ws.readFile("nope.ts")).rejects.toThrow(/ENOENT/);
  });

  it("editFile replaces a unique occurrence and rejects ambiguous / missing", async () => {
    const ws = new ModalSandboxWorkspace({ ctx: CTX, sessionKey: "k" });
    await ws.writeFile("e.ts", "foo bar foo");
    await expect(ws.editFile("e.ts", "foo", "baz")).rejects.toThrow(
      /must be unique/,
    );
    expect(await ws.editFile("e.ts", "bar", "BAR")).toBe(1);
    expect(await ws.readFile("e.ts")).toBe("foo BAR foo");
    await expect(ws.editFile("e.ts", "zzz", "x")).rejects.toThrow(/not found/);
  });

  it("editFile replaceAll replaces every occurrence", async () => {
    const ws = new ModalSandboxWorkspace({ ctx: CTX, sessionKey: "k" });
    await ws.writeFile("e.ts", "x x x");
    expect(await ws.editFile("e.ts", "x", "y", { replaceAll: true })).toBe(3);
    expect(await ws.readFile("e.ts")).toBe("y y y");
  });

  it("exec runs the caller command inside the workspace root", async () => {
    const ws = new ModalSandboxWorkspace({ ctx: CTX, sessionKey: "k" });
    await ws.exec("pnpm build", { timeoutMs: 5000 });
    const call = h.execFn.mock.calls.find((c) =>
      c[0].command.includes("pnpm build"),
    )!;
    expect(call[0].command).toBe("cd '/work' && pnpm build");
    expect(call[0].timeoutMs).toBe(5000);
  });

  it("glob filters the file tree with matching semantics", async () => {
    const ws = new ModalSandboxWorkspace({ ctx: CTX, sessionKey: "k" });
    await ws.writeFile("src/a.ts", "");
    await ws.writeFile("src/b.js", "");
    await ws.writeFile("src/nested/c.ts", "");
    expect(await ws.glob("**/*.ts")).toEqual(["src/a.ts", "src/nested/c.ts"]);
  });

  it("glob prefers fd with an alias-immune `command find` fallback", async () => {
    const ws = new ModalSandboxWorkspace({ ctx: CTX, sessionKey: "k" });
    await ws.glob("**/*.ts");
    const call = h.execFn.mock.calls.find((c) =>
      c[0].command.includes("-type f"),
    )!;
    const cmd = call[0].command as string;
    expect(cmd).toContain("command -v fd");
    expect(cmd).toContain("fd --type f --hidden --no-ignore --exclude .git");
    // Bare `find` would be alias-expanded to fd by the runner's exec
    // trampoline and choke on find's expression flags.
    expect(cmd).toContain("command find . -type f -not -path '*/.git/*'");
  });

  it("grep prefers rg with an alias-immune `command grep` fallback and normalized paths", async () => {
    const ws = new ModalSandboxWorkspace({ ctx: CTX, sessionKey: "k" });
    await ws.grep("TODO", { glob: "*.ts" });
    const call = h.execFn.mock.calls.find((c) =>
      c[0].command.includes("--line-number"),
    )!;
    const cmd = call[0].command as string;
    expect(cmd).toContain("command -v rg");
    expect(cmd).toContain(
      "rg --line-number --no-heading --hidden --no-ignore -g '*.ts' -- 'TODO' '.'",
    );
    expect(cmd).toContain("command grep -rInE --include='*.ts' -- 'TODO' '.'");
    // ./-prefix normalization so the .git post-filter applies to both branches.
    expect(cmd).toContain("sed 's|^\\./||'");
    expect(cmd).toContain("command grep -v '^\\.git/'");
  });

  it("getChangedFiles reads back every changed path's content", async () => {
    const ws = new ModalSandboxWorkspace({ ctx: CTX, sessionKey: "k" });
    await ws.writeFile("src/a.ts", "AAA");
    await ws.writeFile("README.md", "docs");
    changedList = ["src/a.ts", "README.md"];
    const changed = await ws.getChangedFiles();
    expect(changed).toEqual([
      { path: "src/a.ts", content: "AAA" },
      { path: "README.md", content: "docs" },
    ]);
  });

  it("clones the repo once with an idempotent .git guard and staged credentials", async () => {
    const ws = new ModalSandboxWorkspace({
      ctx: CTX,
      sessionKey: "k",
      repo: { owner: "o", repo: "r", ref: "main", token: "ghs_secret" },
    });
    await ws.exec("ls");
    const cloneCall = h.execFn.mock.calls.find((c) =>
      c[0].command.includes("git clone"),
    )!;
    expect(cloneCall[0].command).toContain("[ ! -e '/work'/.git ]");
    expect(cloneCall[0].command).toContain("--branch 'main'");
    // Token travels via env for the credential-store step, never in the URL.
    const credCall = h.execFn.mock.calls.find((c) =>
      c[0].command.includes("credential.helper"),
    )!;
    expect(credCall[0].env).toEqual({ OXA_GH_TOKEN: "ghs_secret" });
    expect(cloneCall[0].command).not.toContain("ghs_secret");
  });

  it("rejects path traversal outside the workspace root", async () => {
    const ws = new ModalSandboxWorkspace({ ctx: CTX, sessionKey: "k" });
    await expect(ws.readFile("../../etc/passwd")).rejects.toThrow(
      /unsafe workspace path/,
    );
  });

  it("dispose stops the session; no-op before any start", async () => {
    const ws = new ModalSandboxWorkspace({ ctx: CTX, sessionKey: "k" });
    await ws.dispose();
    expect(h.stopFn).not.toHaveBeenCalled();
    await ws.exec("ls");
    await ws.dispose();
    expect(h.stopFn).toHaveBeenCalledWith({ sessionId: "sbx_1" }, CTX);
  });
});
