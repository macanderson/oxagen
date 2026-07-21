# In-App Coding Agent — Phase 1 (Coding Runner) Implementation Plan

> **⚠️ SUPERSEDED (2026-06-27) by `2026-06-27-unified-agent-engine-plan.md` and `docs/adr/ADR-019-unified-agent-engine.md`.** This plan shared only the inner loop+tools, which would have shipped two diverging agents. Its Stage-C task content (sandbox workspace, coding_sessions schema, contracts/handlers/Inngest, surfaces, diff tray) is still valid and is referenced by the new plan; its narrow engine scope is replaced by the shared `@oxagen/agent-engine`. Kept for that task detail.

> **Launch boundary (2026-07-21):** any central source-code graph, code embedding,
> or automatic execution-to-file lineage described below is also superseded. Exact
> code graphs stay local; verified shared lineage requires the future typed evidence
> ledger.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a server-side, sandboxed agentic coding runner that checks out a connected GitHub repo into a persistent Vercel Sandbox, makes edits with a Claude-Code-style tool loop, and returns a unified diff + summary — invokable end-to-end via a metered, tenant-scoped capability and surfaced live in chat. No GitHub writes yet (Phase 2).

**Architecture:** Extract the CLI's existing filesystem-coupled coding loop into a new `@oxagen/coding-agent` package behind a `Workspace` abstraction with three backends (`LocalWorkspace` for the CLI, `SandboxWorkspace` for the cloud, `MemoryWorkspace` for tests). Orchestrate the cloud run as a durable Inngest job (`agent.coding.session.*`) that provisions a persistent Vercel Sandbox, clones the repo with the connection's KMS-decrypted OAuth token, runs `runCodingAgent`, persists a typed event log + final diff to `coding_sessions`/`coding_session_events`, and tears the sandbox down. The in-app agent calls it as an async tool; the existing background-task tray polls for progress and renders the diff.

**Tech Stack:** TypeScript 6.0.3 (no `any`), Vercel AI SDK (`ai@6.0.x`, `streamText`/`stepCountIs`), `@vercel/sandbox`, Drizzle (Postgres), Inngest, Zod 3.25.76, Vitest 2.1.9.

## Global Constraints

- **No `any`.** Use precise types or `unknown`. (standard-no-any-type)
- **All LLM calls go through `@oxagen/ai`.** Never import `streamText`/`generateText` directly from `ai` inside a handler/route. The engine lives in `@oxagen/coding-agent` and is the single seam; it may use `ai` directly only there, mirroring how `apps/cli` already does, but the *server orchestration* invokes the engine, not `ai`. (ai-gateway-only, single-ai-chokepoint)
- **Raw `db()` is banned.** Use `withTenantDb` / `withSystemDb` / `scopedSession`. (rls-tenancy-enforcement)
- **Every Inngest `step.run` that touches the DB wraps `runInTenantScope({ orgId, workspaceId }, ...)`.** ALS does not cross step boundaries. (inngest-step-tenant-scope)
- **`bootstrapEntitlementRuntime()`** must be called at startup of any new runtime that invokes capability-gated handlers. The Inngest runtime already does; verify.
- **Capability parity:** new user-facing action → contract in `packages/oxagen/src/contracts/` → API route → MCP tool → CLI command → `docs/capabilities/`. Run `pnpm check:manifest`.
- **Instrument everything:** token usage + duration + surface origin on every agent/LLM/tool call, emitted to ClickHouse. (instrument-everything)
- **Migrations** live in `packages/database/atlas/migrations/`, never in `apps/`. Every new table: `ENABLE` + `FORCE ROW LEVEL SECURITY`, a `tenant_isolation` policy, and `oxagen_app` grants. Never edit an applied migration — add a new forward one. (migration-immutability-cross-db-checksum)
- **Tests:** new code requires new tests. Run only the narrowest implicated test (`pnpm --filter <pkg> test:unit -- <file>`); NEVER run the whole suite. Coverage ratchet ≤90 with ≥2.5% headroom.
- **Sandbox gating:** the runner requires `SANDBOX_ENABLED=true` and `SANDBOX_DRIVER=vercel`. Guard with `isSandboxAvailable()` and fail closed with a clean message when unavailable.
- **Branch:** `feat/in-app-coding-agent` in the isolated worktree `/Users/macanderson/oxagen-coding-runner`. Commit + push frequently. Never commit to `main`.

---

## File Structure

**New package `@oxagen/coding-agent`** (`packages/coding-agent/`):
- `package.json`, `tsconfig.json`, `vitest.config.ts`, `.eslintignore` — scaffold.
- `src/types.ts` — `Workspace`, `CommandResult`, `CodingEvent`, `CodeGraphProvider`, `RunCodingAgentOptions`, `RunCodingAgentResult`.
- `src/workspaces/local.ts` — `LocalWorkspace` (node:fs + child_process).
- `src/workspaces/memory.ts` — `MemoryWorkspace` (in-memory, test-only).
- `src/tools.ts` — `buildWorkspaceTools(workspace, codeGraph?, { readOnly })` (the 8 tools, rebased to `Workspace`).
- `src/engine.ts` — `runCodingAgent(opts)` (the loop + typed events).
- `src/index.ts` — barrel.

**Extend `packages/sandbox/`:**
- `src/types.ts:` add `SandboxWorkspaceHandle` + `createWorkspace` to `SandboxDriver`.
- `src/vercel.ts:` implement `createWorkspace`.
- `src/docker.ts`, `src/modal.ts:` add `createWorkspace` (docker real; modal throws "unsupported in Phase 1").

**`@oxagen/coding-agent` cloud adapter:**
- `src/workspaces/sandbox.ts` — `SandboxWorkspace` implementing `Workspace` over a `SandboxWorkspaceHandle`.

**Database (`packages/database/`):**
- `src/schema/coding.ts` — `codingSessions`, `codingSessionEvents` tables.
- `src/schema/index.ts` — export them.
- `atlas/migrations/<ts>_coding_sessions.sql` — DDL + RLS + grants.

**Contracts (`packages/oxagen/src/contracts/`):**
- `agent.coding.session.start.ts`, `agent.coding.session.get.ts`, `agent.coding.session.cancel.ts` + `index.ts` registration.

**Handlers (`packages/handlers/src/`):**
- `agent.coding.session.start.ts`, `agent.coding.session.get.ts`, `agent.coding.session.cancel.ts` + `register.ts` wiring.

**Inngest (`packages/inngest-functions/src/`):**
- `inngest.ts` — add `agent/coding.session.start` + `agent/coding.session.cancel` events.
- `functions/agent.coding-session.execute.ts` — the orchestrator.
- `functions/index.ts` — register.

**Surfaces:**
- `apps/mcp/src/tools/agent.coding.session.{start,get,cancel}.ts`.
- `apps/api/src/routes/v1/agent.coding.ts` + mount in `apps/api/src/app.ts`.
- `apps/cli/src/commands/code.ts` (new `oxagen code` command) + refactor `apps/cli/src/agent/{loop,tools}.ts` to consume `@oxagen/coding-agent`.

**App:**
- `apps/app/src/components/chat/...` — render the coding session in the background-task tray (diff view).

**Docs:** `docs/capabilities/agent.coding.session.start.md` (+ get/cancel), `_index.md`.

---

## Task 1: Scaffold `@oxagen/coding-agent` + the `Workspace` contract

**Files:**
- Create: `packages/coding-agent/package.json`, `tsconfig.json`, `vitest.config.ts`, `.eslintignore`
- Create: `packages/coding-agent/src/types.ts`
- Create: `packages/coding-agent/src/index.ts`
- Test: `packages/coding-agent/src/types.test.ts`

**Interfaces:**
- Produces:
  - `interface CommandResult { exitCode: number; stdout: string; stderr: string; timedOut: boolean }`
  - `interface Workspace { root: string; readFile(p: string, opts?: { offset?: number; limit?: number }): Promise<string>; writeFile(p: string, content: string): Promise<void>; editFile(p: string, oldString: string, newString: string): Promise<void>; list(dir?: string): Promise<string[]>; glob(pattern: string): Promise<string[]>; grep(pattern: string, opts?: { path?: string; glob?: string }): Promise<string[]>; exec(command: string, opts?: { timeoutMs?: number }): Promise<CommandResult>; diff(): Promise<string> }`
  - `type CodingEvent = { type: "text"; delta: string } | { type: "tool-call"; name: string; input: unknown } | { type: "tool-result"; name: string; output: string } | { type: "file-edit"; path: string; bytes: number } | { type: "command"; command: string; exitCode: number } | { type: "final-diff"; diff: string; changedFiles: string[] }`
  - `interface CodeGraphProvider { query(operation: "search" | "file_symbols" | "dependents" | "imports", query: string, limit?: number): Promise<string> }`
  - `interface RunCodingAgentOptions { workspace: Workspace; instruction: string; model?: string; system?: string; history?: import("ai").ModelMessage[]; maxSteps?: number; readOnly?: boolean; codeGraph?: CodeGraphProvider; signal?: AbortSignal; onEvent?: (e: CodingEvent) => void }`
  - `interface RunCodingAgentResult { text: string; steps: number; diff: string; changedFiles: string[]; usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }; messages: import("ai").ModelMessage[] }`

- [ ] **Step 1: Write the package scaffold**

`packages/coding-agent/package.json`:
```json
{
  "name": "@oxagen/coding-agent",
  "version": "0.5.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint src --max-warnings 0",
    "test:unit": "vitest run",
    "test:coverage": "vitest run --coverage"
  },
  "dependencies": {
    "ai": "6.0.48",
    "zod": "3.25.76"
  },
  "devDependencies": {
    "@types/node": "25.9.1",
    "@vitest/coverage-v8": "2.1.9",
    "eslint": "8.57.1",
    "typescript": "6.0.3",
    "vitest": "2.1.9"
  }
}
```
> NOTE: pin `ai` to the exact version already in the lockfile — read `apps/cli/package.json`'s `ai` version and match it verbatim instead of `6.0.48` if it differs.

`packages/coding-agent/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist" },
  "include": ["src/**/*.ts"]
}
```

`packages/coding-agent/vitest.config.ts`:
```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: { lines: 85, branches: 80, functions: 80, statements: 85 },
    },
  },
});
```

`packages/coding-agent/.eslintignore`:
```
node_modules
dist
coverage
```

- [ ] **Step 2: Write `src/types.ts`** — exactly the interfaces in the "Produces" block above. Each as an exported `interface`/`type`. No implementations.

- [ ] **Step 3: Write `src/index.ts`**
```typescript
export * from "./types";
export { LocalWorkspace } from "./workspaces/local";
export { MemoryWorkspace } from "./workspaces/memory";
export { buildWorkspaceTools } from "./tools";
export { runCodingAgent } from "./engine";
```
> The non-existent imports will fail typecheck until later tasks land — that is expected; this task's gate is only Step 5's compile of `types.ts`. Temporarily comment the not-yet-created exports and uncomment them in the task that creates each.

- [ ] **Step 4: Write the failing test** `src/types.test.ts`
```typescript
import { describe, it, expect } from "vitest";
import type { Workspace, CodingEvent } from "./types";

describe("types", () => {
  it("CodingEvent union includes final-diff", () => {
    const e: CodingEvent = { type: "final-diff", diff: "", changedFiles: [] };
    expect(e.type).toBe("final-diff");
  });
  it("Workspace shape is structurally usable", () => {
    const w: Pick<Workspace, "root"> = { root: "/tmp/repo" };
    expect(w.root).toBe("/tmp/repo");
  });
});
```

- [ ] **Step 5: Install + typecheck + test**

Run:
```bash
pnpm i --no-frozen-lockfile
pnpm --filter @oxagen/coding-agent typecheck
pnpm --filter @oxagen/coding-agent test:unit
```
Expected: typecheck passes for `types.ts`/`types.test.ts` (with the not-yet-created barrel exports commented out); test PASS.

- [ ] **Step 6: Commit**
```bash
git add packages/coding-agent pnpm-lock.yaml
git commit -m "feat(coding-agent): scaffold package + Workspace contract"
```

---

## Task 2: `MemoryWorkspace` (in-memory backend for deterministic tests)

**Files:**
- Create: `packages/coding-agent/src/workspaces/memory.ts`
- Test: `packages/coding-agent/src/workspaces/memory.test.ts`

**Interfaces:**
- Consumes: `Workspace`, `CommandResult` from `../types`.
- Produces: `class MemoryWorkspace implements Workspace` with constructor `(files: Record<string, string>, root?: string)`. `exec` supports a registered command map via `onExec(fn: (cmd: string) => CommandResult)`; default returns `{ exitCode: 0, stdout: "", stderr: "", timedOut: false }`. `diff()` returns a synthetic unified diff of changed-vs-initial files.

- [ ] **Step 1: Write the failing test** `src/workspaces/memory.test.ts`
```typescript
import { describe, it, expect } from "vitest";
import { MemoryWorkspace } from "./memory";

describe("MemoryWorkspace", () => {
  it("reads and writes files", async () => {
    const ws = new MemoryWorkspace({ "a.txt": "hello" });
    expect(await ws.readFile("a.txt")).toBe("hello");
    await ws.writeFile("b.txt", "world");
    expect(await ws.readFile("b.txt")).toBe("world");
  });

  it("editFile replaces a unique substring and rejects non-unique", async () => {
    const ws = new MemoryWorkspace({ "a.txt": "foo bar foo" });
    await expect(ws.editFile("a.txt", "foo", "x")).rejects.toThrow(/unique|appears/i);
    await ws.editFile("a.txt", "bar", "baz");
    expect(await ws.readFile("a.txt")).toBe("foo baz foo");
  });

  it("glob matches ** and * patterns", async () => {
    const ws = new MemoryWorkspace({ "src/x.ts": "", "src/deep/y.ts": "", "z.js": "" });
    expect((await ws.glob("src/**/*.ts")).sort()).toEqual(["src/deep/y.ts", "src/x.ts"]);
  });

  it("grep returns file:line:text hits", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "const a = 1\nconst b = 2" });
    expect(await ws.grep("const b")).toEqual(["a.ts:2:const b = 2"]);
  });

  it("diff reports changed files", async () => {
    const ws = new MemoryWorkspace({ "a.txt": "1" });
    await ws.writeFile("a.txt", "2");
    const d = await ws.diff();
    expect(d).toContain("a.txt");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @oxagen/coding-agent test:unit -- memory.test.ts`
Expected: FAIL — `MemoryWorkspace` not found.

- [ ] **Step 3: Implement `src/workspaces/memory.ts`**

Implement against the `Workspace` interface. Reuse the CLI's `globToRegExp` algorithm (copy from `apps/cli/src/agent/tools.ts:50-72`) for `glob`/`grep`. Track an `initial` snapshot in the constructor and a mutable `files` map. `editFile` mirrors the CLI's count-must-equal-1 rule (`tools.ts:159-172`). `diff()` emits a minimal unified diff listing each path whose content differs from `initial` (header `--- a/<path>` / `+++ b/<path>` is sufficient for tests). `exec` returns the injected handler's result or the zero-default.

```typescript
import type { CommandResult, Workspace } from "../types";

// Minimal glob → regex (copied from apps/cli/src/agent/tools.ts globToRegExp).
function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") { re += ".*"; i++; if (pattern[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (".+^${}()|[]\\".includes(c as string)) re += "\\" + c;
    else re += c;
  }
  return new RegExp("^" + re + "$");
}

export class MemoryWorkspace implements Workspace {
  readonly root: string;
  private files: Map<string, string>;
  private initial: Map<string, string>;
  private execHandler: (cmd: string) => CommandResult = () => ({
    exitCode: 0, stdout: "", stderr: "", timedOut: false,
  });

  constructor(files: Record<string, string> = {}, root = "/repo") {
    this.root = root;
    this.files = new Map(Object.entries(files));
    this.initial = new Map(Object.entries(files));
  }

  onExec(fn: (cmd: string) => CommandResult): void { this.execHandler = fn; }

  async readFile(p: string, opts?: { offset?: number; limit?: number }): Promise<string> {
    const text = this.files.get(p);
    if (text === undefined) throw new Error(`ENOENT: ${p}`);
    if (opts?.offset == null && opts?.limit == null) return text;
    const lines = text.split("\n");
    const start = opts?.offset ? opts.offset - 1 : 0;
    const end = opts?.limit ? start + opts.limit : lines.length;
    return lines.slice(start, end).join("\n");
  }

  async writeFile(p: string, content: string): Promise<void> { this.files.set(p, content); }

  async editFile(p: string, oldString: string, newString: string): Promise<void> {
    const text = this.files.get(p);
    if (text === undefined) throw new Error(`ENOENT: ${p}`);
    const count = text.split(oldString).length - 1;
    if (count === 0) throw new Error(`old_string not found in ${p}`);
    if (count > 1) throw new Error(`old_string appears ${count} times in ${p}; must be unique`);
    this.files.set(p, text.replace(oldString, newString));
  }

  async list(dir = "."): Promise<string[]> {
    const prefix = dir === "." ? "" : dir.replace(/\/$/, "") + "/";
    const names = new Set<string>();
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length).split("/")[0];
      if (rest) names.add(rest);
    }
    return [...names].sort();
  }

  async glob(pattern: string): Promise<string[]> {
    const re = globToRegExp(pattern);
    return [...this.files.keys()].filter((p) => re.test(p)).sort();
  }

  async grep(pattern: string, opts?: { path?: string; glob?: string }): Promise<string[]> {
    const re = new RegExp(pattern);
    const fileRe = opts?.glob ? globToRegExp(opts.glob.includes("/") ? opts.glob : `**/${opts.glob}`) : null;
    const hits: string[] = [];
    for (const [path, text] of this.files) {
      if (opts?.path && !path.startsWith(opts.path)) continue;
      if (fileRe && !fileRe.test(path)) continue;
      text.split("\n").forEach((line, i) => {
        if (re.test(line)) hits.push(`${path}:${i + 1}:${line.slice(0, 200)}`);
      });
    }
    return hits;
  }

  async exec(command: string): Promise<CommandResult> { return this.execHandler(command); }

  async diff(): Promise<string> {
    const out: string[] = [];
    const paths = new Set([...this.files.keys(), ...this.initial.keys()]);
    for (const p of [...paths].sort()) {
      if (this.files.get(p) !== this.initial.get(p)) {
        out.push(`--- a/${p}`, `+++ b/${p}`);
      }
    }
    return out.join("\n");
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @oxagen/coding-agent test:unit -- memory.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**
```bash
git add packages/coding-agent/src/workspaces/memory.ts packages/coding-agent/src/workspaces/memory.test.ts
git commit -m "feat(coding-agent): MemoryWorkspace in-memory backend"
```

---

## Task 3: `buildWorkspaceTools` — the 8 coding tools, rebased to `Workspace`

**Files:**
- Create: `packages/coding-agent/src/tools.ts`
- Test: `packages/coding-agent/src/tools.test.ts`

**Interfaces:**
- Consumes: `Workspace`, `CodeGraphProvider`, `CodingEvent` from `../types`; `tool`, `ToolSet` from `ai`; `z` from `zod`.
- Produces: `function buildWorkspaceTools(workspace: Workspace, opts?: { readOnly?: boolean; codeGraph?: CodeGraphProvider; onEvent?: (e: CodingEvent) => void }): ToolSet`. Tools: `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`, `code_graph`, `bash` — same names/schemas as `apps/cli/src/agent/tools.ts`, but `execute` delegates to the `Workspace` methods. `read_only` deletes `write_file`/`edit_file`/`bash`. `code_graph` is omitted when no `codeGraph` provider is supplied. Each mutating/command tool calls `onEvent` (`file-edit`, `command`).

- [ ] **Step 1: Write the failing test** `src/tools.test.ts`
```typescript
import { describe, it, expect, vi } from "vitest";
import { MemoryWorkspace } from "./workspaces/memory";
import { buildWorkspaceTools } from "./tools";
import type { CodingEvent } from "./types";

async function run(tool: unknown, input: unknown): Promise<string> {
  // AI SDK tool().execute signature: (input, { toolCallId, messages }) => result
  return (tool as { execute: (i: unknown, o: unknown) => Promise<string> }).execute(input, {});
}

describe("buildWorkspaceTools", () => {
  it("read_file returns file content", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "hello" });
    const tools = buildWorkspaceTools(ws);
    expect(await run(tools.read_file, { path: "a.ts" })).toBe("hello");
  });

  it("edit_file emits a file-edit event and mutates the workspace", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "foo" });
    const events: CodingEvent[] = [];
    const tools = buildWorkspaceTools(ws, { onEvent: (e) => events.push(e) });
    await run(tools.edit_file, { path: "a.ts", old_string: "foo", new_string: "bar" });
    expect(await ws.readFile("a.ts")).toBe("bar");
    expect(events.some((e) => e.type === "file-edit" && e.path === "a.ts")).toBe(true);
  });

  it("readOnly withholds mutating tools", () => {
    const ws = new MemoryWorkspace({});
    const tools = buildWorkspaceTools(ws, { readOnly: true });
    expect(tools.write_file).toBeUndefined();
    expect(tools.edit_file).toBeUndefined();
    expect(tools.bash).toBeUndefined();
    expect(tools.read_file).toBeDefined();
  });

  it("code_graph is present only with a provider", () => {
    const ws = new MemoryWorkspace({});
    expect(buildWorkspaceTools(ws).code_graph).toBeUndefined();
    const withGraph = buildWorkspaceTools(ws, {
      codeGraph: { query: async () => "result" },
    });
    expect(withGraph.code_graph).toBeDefined();
  });

  it("bash delegates to workspace.exec and emits a command event", async () => {
    const ws = new MemoryWorkspace({});
    ws.onExec(() => ({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false }));
    const events: CodingEvent[] = [];
    const tools = buildWorkspaceTools(ws, { onEvent: (e) => events.push(e) });
    const out = await run(tools.bash, { command: "echo ok" });
    expect(out).toContain("ok");
    expect(events.some((e) => e.type === "command")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @oxagen/coding-agent test:unit -- tools.test.ts`
Expected: FAIL — `buildWorkspaceTools` not found.

- [ ] **Step 3: Implement `src/tools.ts`**

Port `apps/cli/src/agent/tools.ts` verbatim in shape, replacing every `fs`/`execAsync`/walk call with the corresponding `Workspace` method, keeping `clip()` (MAX_OUTPUT 30_000) and the identical tool `description`/`inputSchema`. `read_file`→`workspace.readFile`; `write_file`→`workspace.writeFile` then `onEvent({type:"file-edit"})`; `edit_file`→`workspace.editFile` then `onEvent`; `list_dir`→`workspace.list`; `glob`→`workspace.glob`; `grep`→`workspace.grep`; `bash`→`workspace.exec` then `onEvent({type:"command", command, exitCode})`; `code_graph`→`opts.codeGraph.query`. Wrap each `execute` body in try/catch returning a string error (same as the CLI). Delete the three mutating tools when `opts.readOnly`. Delete `code_graph` when `!opts.codeGraph`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @oxagen/coding-agent test:unit -- tools.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**
```bash
git add packages/coding-agent/src/tools.ts packages/coding-agent/src/tools.test.ts
git commit -m "feat(coding-agent): workspace-bound coding tools"
```

---

## Task 4: `runCodingAgent` — the engine loop with typed events + diff

**Files:**
- Create: `packages/coding-agent/src/engine.ts`
- Test: `packages/coding-agent/src/engine.test.ts`

**Interfaces:**
- Consumes: `RunCodingAgentOptions`, `RunCodingAgentResult`, `CodingEvent` from `../types`; `buildWorkspaceTools` from `./tools`; `streamText`, `stepCountIs`, `ModelMessage` from `ai`.
- Produces: `async function runCodingAgent(opts: RunCodingAgentOptions): Promise<RunCodingAgentResult>`. Mirrors `apps/cli/src/agent/loop.ts:99-179` (`streamText` + `stopWhen: stepCountIs(maxSteps ?? 32)` + `onStepFinish` forwarding tool calls), but: (a) builds tools from `buildWorkspaceTools(workspace, { readOnly, codeGraph, onEvent })`; (b) streams text deltas to `onEvent({type:"text"})`; (c) after the loop, calls `workspace.diff()`, derives `changedFiles` from the diff, and emits `onEvent({type:"final-diff"})`; (d) returns `{ text, steps, diff, changedFiles, usage, messages }`. The model is injected via `opts.model` (resolved by the caller; the engine accepts a model id string and passes it to `streamText({ model })`). The default system prompt is a constant; callers override via `opts.system`.

- [ ] **Step 1: Write the failing test** `src/engine.test.ts`

Mock `ai`'s `streamText` so the test is deterministic (no network). The mock returns a fake stream that "edits" a file through the tool, then yields text.
```typescript
import { describe, it, expect, vi } from "vitest";
import { MemoryWorkspace } from "./workspaces/memory";
import type { CodingEvent } from "./types";

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    streamText: vi.fn((cfg: { tools: Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }> }) => {
      return {
        // Simulate the model editing a file via the edit_file tool, then replying.
        textStream: (async function* () {
          await cfg.tools.edit_file.execute({ path: "a.ts", old_string: "foo", new_string: "bar" }, {});
          yield "done";
        })(),
        steps: Promise.resolve([{}]),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
        response: Promise.resolve({ messages: [] }),
      };
    }),
  };
});

import { runCodingAgent } from "./engine";

describe("runCodingAgent", () => {
  it("runs the loop, applies edits, and returns a diff", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "foo" });
    const events: CodingEvent[] = [];
    const result = await runCodingAgent({
      workspace: ws,
      instruction: "rename foo to bar",
      model: "anthropic/claude-opus-4-8",
      onEvent: (e) => events.push(e),
    });
    expect(await ws.readFile("a.ts")).toBe("bar");
    expect(result.diff).toContain("a.ts");
    expect(result.changedFiles).toContain("a.ts");
    expect(result.usage.totalTokens).toBe(3);
    expect(events.some((e) => e.type === "final-diff")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @oxagen/coding-agent test:unit -- engine.test.ts`
Expected: FAIL — `runCodingAgent` not found.

- [ ] **Step 3: Implement `src/engine.ts`**

```typescript
import { streamText, stepCountIs, type ModelMessage } from "ai";
import { buildWorkspaceTools } from "./tools";
import type { CodingEvent, RunCodingAgentOptions, RunCodingAgentResult } from "./types";

const DEFAULT_SYSTEM =
  "You are an expert software engineer working in a checked-out repository. " +
  "Use the provided tools to read, search, and edit files and run commands. " +
  "Make the smallest correct change that satisfies the request, run the repo's " +
  "tests or build when relevant, and stop when the task is complete.";

// Parse `git diff` output for the set of changed file paths (b/<path> headers).
export function changedFilesFromDiff(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split("\n")) {
    const m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m && m[1] !== "/dev/null") files.add(m[1]);
  }
  return [...files].sort();
}

export async function runCodingAgent(opts: RunCodingAgentOptions): Promise<RunCodingAgentResult> {
  const onEvent = opts.onEvent ?? (() => undefined);
  const tools = buildWorkspaceTools(opts.workspace, {
    readOnly: opts.readOnly,
    codeGraph: opts.codeGraph,
    onEvent,
  });

  const messages: ModelMessage[] = [
    ...(opts.history ?? []),
    { role: "user", content: opts.instruction },
  ];

  let streamError: unknown = null;
  const result = streamText({
    model: opts.model ?? "anthropic/claude-opus-4-8",
    system: opts.system ?? DEFAULT_SYSTEM,
    messages,
    tools,
    stopWhen: stepCountIs(opts.maxSteps ?? 32),
    abortSignal: opts.signal,
    onError: ({ error }) => { streamError = error; },
    onStepFinish: ({ toolCalls }) => {
      for (const tc of toolCalls ?? []) {
        const call = tc as { toolName: string; input?: unknown; args?: unknown };
        onEvent({ type: "tool-call", name: call.toolName, input: call.input ?? call.args });
      }
    },
  });

  let text = "";
  try {
    for await (const delta of result.textStream) {
      text += delta;
      onEvent({ type: "text", delta });
    }
  } catch (err) {
    streamError ??= err;
  }
  if (streamError) throw streamError instanceof Error ? streamError : new Error(String(streamError));

  const steps = (await result.steps).length;
  const usage = await result.usage;
  const response = await result.response;

  const diff = await opts.workspace.diff();
  const changedFiles = changedFilesFromDiff(diff);
  onEvent({ type: "final-diff", diff, changedFiles });

  return {
    text,
    steps,
    diff,
    changedFiles,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
    },
    messages: [...messages, ...response.messages],
  };
}
```
> Add a `changedFilesFromDiff` unit test inline (real `git diff` has `+++ b/path` lines; `MemoryWorkspace.diff()` emits them too).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @oxagen/coding-agent test:unit -- engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Uncomment the barrel exports in `src/index.ts`, typecheck, commit**
```bash
pnpm --filter @oxagen/coding-agent typecheck
git add packages/coding-agent/src/engine.ts packages/coding-agent/src/engine.test.ts packages/coding-agent/src/index.ts
git commit -m "feat(coding-agent): runCodingAgent engine with typed events + diff"
```

---

## Task 5: `LocalWorkspace` + refactor the CLI onto the shared engine

**Files:**
- Create: `packages/coding-agent/src/workspaces/local.ts`
- Test: `packages/coding-agent/src/workspaces/local.test.ts`
- Modify: `apps/cli/src/agent/loop.ts` (delegate to `runCodingAgent` with a `LocalWorkspace`)
- Modify: `apps/cli/src/agent/tools.ts` → **delete** (replaced by `@oxagen/coding-agent`), updating imports
- Modify: `apps/cli/package.json` (add `@oxagen/coding-agent` dep)

**Interfaces:**
- Consumes: `Workspace`, `CommandResult`; node `fs`/`child_process`.
- Produces: `class LocalWorkspace implements Workspace` constructed with `(cwd: string)`. Reuses the exact algorithms in today's `apps/cli/src/agent/tools.ts` (walk/glob/grep/exec). `diff()` runs `git -C <cwd> diff`.

- [ ] **Step 1: Write the failing test** `src/workspaces/local.test.ts` — create a temp dir with `node:fs`, write files, assert `readFile`/`writeFile`/`editFile`/`glob`/`grep`/`exec`/`list` behave like the CLI did, and `diff()` returns `""` for a non-git dir (guard) or a real diff in a `git init`'d temp repo.
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWorkspace } from "./local";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "lw-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("LocalWorkspace", () => {
  it("reads, writes, edits, globs, greps", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/a.ts"), "const a = 1\n");
    const ws = new LocalWorkspace(dir);
    expect(await ws.readFile("src/a.ts")).toContain("const a = 1");
    await ws.writeFile("src/b.ts", "const b = 2\n");
    expect(await ws.glob("src/**/*.ts")).toEqual(["src/a.ts", "src/b.ts"]);
    expect(await ws.grep("const b")).toEqual(["src/b.ts:1:const b = 2"]);
    await ws.editFile("src/a.ts", "const a = 1", "const a = 99");
    expect(await ws.readFile("src/a.ts")).toContain("const a = 99");
    const r = await ws.exec("echo hi");
    expect(r.stdout.trim()).toBe("hi");
  });
});
```

- [ ] **Step 2: Run + verify fail.** `pnpm --filter @oxagen/coding-agent test:unit -- local.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/workspaces/local.ts`** by lifting the algorithms from `apps/cli/src/agent/tools.ts` (`walk`, `globToRegExp`, `IGNORE_DIRS`, the `read_file`/`write_file`/`edit_file`/`list_dir`/`glob`/`grep`/`bash` bodies) into `Workspace` methods over `this.cwd`. `exec` uses `promisify(exec)` with `{ cwd, timeout, maxBuffer: 10*1024*1024, shell: "/bin/bash" }` returning `CommandResult`. `diff()` runs `git -C <cwd> diff` via `exec`, returning `stdout` (empty string on non-zero exit, e.g. not a git repo).

- [ ] **Step 4: Run + verify pass.** Expected: PASS.

- [ ] **Step 5: Refactor the CLI loop.** In `apps/cli/src/agent/loop.ts`, replace `buildTools(cwd, …)` usage with `runCodingAgent` from `@oxagen/coding-agent`:
  - Keep the CLI's `RunAgentOptions`/`RunAgentResult` public shape and all CLI-specific behavior (gateway key check, project memory recall/remember, system prompt assembly via `buildSystemPrompt`, error normalization via `normalizeAgentError`).
  - Inside `runAgent`, construct `const workspace = new LocalWorkspace(cwd)`, build the same `system` string, then call `runCodingAgent({ workspace, instruction: opts.prompt, model: resolveModelId(opts.model), system, history: opts.history, maxSteps: opts.maxSteps, readOnly: opts.readOnly, signal: opts.signal, codeGraph: <CLI local code-graph provider wrapping queryCodeGraph(cwd, …)>, onEvent: (e) => { if (e.type === "text") opts.onText?.(e.delta); if (e.type === "tool-call") opts.onToolCall?.(e.name, e.input); } })`.
  - Map `RunCodingAgentResult` → `RunAgentResult` (`text`, `steps`, `messages`, `usage`). Preserve the memory `remember(...)` calls.
  - Wrap the call in the existing try/catch and rethrow via `normalizeAgentError`.
  - **Delete `apps/cli/src/agent/tools.ts`** and update any other importer (`grep -rl "agent/tools" apps/cli/src`) to import from `@oxagen/coding-agent` or the new local provider.
  - Add `"@oxagen/coding-agent": "workspace:*"` to `apps/cli/package.json` dependencies.

- [ ] **Step 6: Run the CLI's agent tests** (the existing ones — `loop` error-normalization, plus any tool tests now pointing at the package). Run:
```bash
pnpm i --no-frozen-lockfile
pnpm --filter @oxagen/cli typecheck
pnpm --filter @oxagen/cli test:unit -- loop
```
Expected: PASS, no behavior change. (If a deleted-tools test file remains, move it under `@oxagen/coding-agent` or delete it.)

- [ ] **Step 7: Commit**
```bash
git add packages/coding-agent apps/cli pnpm-lock.yaml
git commit -m "refactor(cli): consume @oxagen/coding-agent (LocalWorkspace); one shared engine"
```

---

## Task 6: Persistent sandbox workspace (`packages/sandbox` + `SandboxWorkspace`)

**Files:**
- Modify: `packages/sandbox/src/types.ts` (add `SandboxWorkspaceHandle` + `createWorkspace` to `SandboxDriver`)
- Modify: `packages/sandbox/src/vercel.ts` (implement `createWorkspace`)
- Modify: `packages/sandbox/src/docker.ts`, `src/modal.ts` (implement/stub `createWorkspace`)
- Test: `packages/sandbox/src/vercel.workspace.test.ts`
- Create: `packages/coding-agent/src/workspaces/sandbox.ts` (`SandboxWorkspace implements Workspace`)
- Test: `packages/coding-agent/src/workspaces/sandbox.test.ts`
- Modify: `packages/coding-agent/package.json` (add `@oxagen/sandbox` dep)

**Interfaces:**
- Produces in `@oxagen/sandbox`:
  - `interface SandboxWorkspaceHandle { exec(command: string, opts?: { timeoutMs?: number; cwd?: string }): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>; readFile(path: string): Promise<string>; writeFile(path: string, content: string): Promise<void>; stop(): Promise<void> }`
  - `createWorkspace(opts: { networkPolicy?: "allow" | "deny"; env?: Record<string,string>; timeoutMs?: number }): Promise<SandboxWorkspaceHandle>` added to `SandboxDriver` (optional; Vercel + Docker implement it, Modal throws `SandboxUnsupportedError`).
- Produces in `@oxagen/coding-agent`: `class SandboxWorkspace implements Workspace` constructed with `(handle: SandboxWorkspaceHandle, root: string)`. `glob`/`grep`/`list`/`diff` run shell (`find`, `grep -rn`, `ls`, `git -C <root> diff`) via `handle.exec`; `readFile`/`writeFile`/`editFile` via `handle.readFile/writeFile`.

- [ ] **Step 1: Write the failing test** `packages/sandbox/src/vercel.workspace.test.ts` using the existing `SandboxFactory` mock seam (`createVercelSandbox(config, sandboxImpl)`).
```typescript
import { describe, it, expect, vi } from "vitest";
import { createVercelSandbox, type SandboxFactory } from "./vercel";

function fakeSandbox() {
  return {
    fs: {
      writeFile: vi.fn(async () => undefined),
      readFile: vi.fn(async () => "file-content"),
    },
    runCommand: vi.fn(async () => ({
      exitCode: 0,
      stdout: async () => "out",
      stderr: async () => "",
    })),
    stop: vi.fn(async () => undefined),
  };
}

describe("vercel createWorkspace", () => {
  it("creates a persistent sandbox, execs multiple commands, then stops once", async () => {
    const sb = fakeSandbox();
    const impl: SandboxFactory = { create: vi.fn(async () => sb) as never };
    const driver = createVercelSandbox({}, impl);
    const ws = await driver.createWorkspace!({ networkPolicy: "allow" });
    const a = await ws.exec("git --version");
    const b = await ws.exec("ls");
    expect(a.exitCode).toBe(0);
    expect(b.stdout).toBe("out");
    expect(impl.create).toHaveBeenCalledTimes(1); // ONE microVM reused
    expect(sb.stop).not.toHaveBeenCalled();
    await ws.stop();
    expect(sb.stop).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run + verify fail.** `pnpm --filter @oxagen/sandbox test:unit -- vercel.workspace.test.ts` → FAIL (`createWorkspace` undefined).

- [ ] **Step 3: Implement.**
  - `types.ts`: add `SandboxWorkspaceHandle` and `createWorkspace?` to `SandboxDriver`.
  - `vercel.ts`: implement `createWorkspace` — call `SandboxImpl.create({ runtime: "node24", networkPolicy, timeout: opts.timeoutMs ?? 1_800_000, env: opts.env, resources: { vcpus: 2 }, ...(credentials ?? {}) })` ONCE, return a handle whose `exec(command)` does `sandbox.runCommand({ cmd: "/bin/sh", args: ["-c", command], env: opts.env })` and resolves stdout/stderr (the SDK returns async `stdout()`/`stderr()`), `readFile`→`sandbox.fs.readFile`, `writeFile`→`sandbox.fs.writeFile`, `stop`→`sandbox.stop()`. Reuse `MAX_OUTPUT_CHARS` truncation. Apply a per-exec `timedOut` heuristic only if needed (default false).
  - `docker.ts`: implement `createWorkspace` against a long-lived container (reuse the hardened config; keep the container running, `exec` via `container.exec`).
  - `modal.ts`: `async createWorkspace() { throw new SandboxUnsupportedError("Modal driver does not support persistent workspaces in Phase 1"); }` (define/export the error if absent).

- [ ] **Step 4: Run + verify pass.** Expected: PASS, `create` called once, `stop` once.

- [ ] **Step 5: Implement + test `SandboxWorkspace`** in `@oxagen/coding-agent`. Add `"@oxagen/sandbox": "workspace:*"` to its `package.json`. Test with a fake `SandboxWorkspaceHandle` (record `exec` commands; assert `glob` issues a `find`, `grep` issues `grep -rn`, `diff` issues `git -C <root> diff`).
```typescript
// sandbox.test.ts sketch
import { describe, it, expect, vi } from "vitest";
import { SandboxWorkspace } from "./sandbox";

const handle = (execImpl: (c: string) => Promise<{exitCode:number;stdout:string;stderr:string;timedOut:boolean}>) => ({
  exec: vi.fn(execImpl),
  readFile: vi.fn(async () => "x"),
  writeFile: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
});

describe("SandboxWorkspace", () => {
  it("diff shells out to git diff", async () => {
    const h = handle(async () => ({ exitCode: 0, stdout: "diff --git a", stderr: "", timedOut: false }));
    const ws = new SandboxWorkspace(h, "/repo");
    expect(await ws.diff()).toContain("diff --git");
    expect(h.exec).toHaveBeenCalledWith(expect.stringContaining("git -C /repo diff"), expect.anything());
  });
});
```
Implement `SandboxWorkspace` accordingly (parse `grep -rn`/`find` output into the same `file:line:text` / path-list shapes the tools expect).

- [ ] **Step 6: Run both packages' new tests + typecheck + commit**
```bash
pnpm --filter @oxagen/sandbox test:unit -- vercel.workspace.test.ts
pnpm --filter @oxagen/coding-agent test:unit -- sandbox.test.ts
pnpm --filter @oxagen/sandbox typecheck && pnpm --filter @oxagen/coding-agent typecheck
git add packages/sandbox packages/coding-agent pnpm-lock.yaml
git commit -m "feat(sandbox): persistent Vercel/Docker workspace + SandboxWorkspace adapter"
```

---

## Task 7: Database — `coding_sessions` + `coding_session_events`

**Files:**
- Create: `packages/database/src/schema/coding.ts`
- Modify: `packages/database/src/schema/index.ts` (export)
- Create: `packages/database/atlas/migrations/<timestamp>_coding_sessions.sql`
- Test: `packages/database/src/schema/coding.test.ts` (shape assertions, optional but include a column-presence test)

**Interfaces:**
- Produces: `schema.codingSessions` and `schema.codingSessionEvents` Drizzle tables. `codingSessions` columns: `idMixin("cds")` + `auditMixin()` + `orgScopeMixin()` + `connectionId uuid`, `instruction text`, `baseBranch text`, `status text` (CHECK pending|running|completed|failed|cancelled), `inngestRunId text`, `diff text`, `changedFiles jsonb`, `summary text`, `failureReason text`, `startedAt`, `completedAt`. `codingSessionEvents`: `idMixin("cse")` + `orgScopeMixin()` + `sessionId uuid` (FK→coding_sessions.id), `seq integer`, `kind text`, `payload jsonb`, `createdAt`.

- [ ] **Step 1: Write the schema** `src/schema/coding.ts` following the verbatim `backgroundTasks` pattern (mixins, `text` status + CHECK, indexes on `(org_id, workspace_id, status)` and `(session_id, seq)`).

- [ ] **Step 2: Export** from `src/schema/index.ts`: `export { codingSessions, codingSessionEvents } from "./coding";`

- [ ] **Step 3: Write the migration** `atlas/migrations/<timestamp>_coding_sessions.sql` (timestamp `date +%Y%m%d%H%M%S`, after the latest existing file). Two `CREATE TABLE` in schema `agent`, both with `ENABLE`+`FORCE ROW LEVEL SECURITY`, the `tenant_isolation` policy (copy verbatim from the extracted `background_tasks` example), the `oxagen_app` grants `DO $$` block, indexes, and an FK `coding_session_events.session_id → coding_sessions(id) ON DELETE CASCADE`.

- [ ] **Step 4: Validate locally**

Run (confirm local target; never prod):
```bash
unset DATABASE_URL
pnpm db:lint-migrations
pnpm --filter @oxagen/database typecheck
```
Expected: migration name/checksum lint passes; types compile.

- [ ] **Step 5: Apply + verify with a query** (local Postgres :5433)
```bash
unset DATABASE_URL
pnpm db:migrate
psql postgresql://oxagen:oxagen@localhost:5433/oxagen -c "\d agent.coding_sessions" -c "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='coding_sessions';"
```
Expected: table exists with all columns; `relrowsecurity` and `relforcerowsecurity` both `t`.

- [ ] **Step 6: Commit**
```bash
git add packages/database/src/schema/coding.ts packages/database/src/schema/index.ts packages/database/atlas/migrations/*coding_sessions.sql packages/database/src/schema/coding.test.ts
git commit -m "feat(database): coding_sessions + coding_session_events (RLS + grants)"
```

---

## Task 8: Contracts — `agent.coding.session.{start,get,cancel}`

**Files:**
- Create: `packages/oxagen/src/contracts/agent.coding.session.start.ts`
- Create: `packages/oxagen/src/contracts/agent.coding.session.get.ts`
- Create: `packages/oxagen/src/contracts/agent.coding.session.cancel.ts`
- Modify: `packages/oxagen/src/contracts/index.ts` (import + export + `contracts` array)
- Test: `packages/oxagen/src/contracts/agent.coding.session.test.ts`

**Interfaces:**
- Produces three `registerCapability(...)` contracts (shape per the verbatim `agent.task.background.start` example):
  - `agent.coding.session.start` — `mode: "async"`, `surfaces: ["api","mcp","agent","cli"]`, `scoped: true`, `agent: { requiresApproval: false, riskLevel: "high", category: "coding" }` (full autonomy → no approval gate; risk high → IAM-gated), `defaultRoles` org Owner/Admin allow + workspace Owner/Member allow. `input: z.object({ connectionId: z.string(), instruction: z.string().min(1), baseBranch: z.string().optional(), maxSteps: z.number().int().min(1).max(200).optional() })`. `output: z.object({ sessionId: z.string(), inngestRunId: z.string() })`.
  - `agent.coding.session.get` — `mode: "sync"`, same surfaces, `input: z.object({ sessionId: z.string() })`, `output: z.object({ sessionId, status, instruction, baseBranch: z.string().nullable(), diff: z.string().nullable(), changedFiles: z.array(z.string()), summary: z.string().nullable(), failureReason: z.string().nullable(), events: z.array(z.object({ seq: z.number(), kind: z.string(), payload: z.unknown(), createdAt: z.string() })), createdAt, startedAt: z.string().nullable(), completedAt: z.string().nullable() })`.
  - `agent.coding.session.cancel` — `mode: "sync"`, `input: z.object({ sessionId: z.string() })`, `output: z.object({ sessionId: z.string(), status: z.string() })`.

- [ ] **Step 1: Write the three contract files** using the extracted `registerCapability` shape verbatim (adjust name/domain `"agent"`/input/output). Export `type ...Input/Output = z.output<...>` from each.

- [ ] **Step 2: Register** in `contracts/index.ts` — add the three imports, add to the `export { … }` block, add to the `export const contracts = [ … ]` array (alphabetical neighborhood of other `agent.*`).

- [ ] **Step 3: Write the test** `agent.coding.session.test.ts`
```typescript
import { describe, it, expect } from "vitest";
import { agentCodingSessionStart } from "./agent.coding.session.start";

describe("agent.coding.session.start contract", () => {
  it("rejects empty instruction", () => {
    const r = agentCodingSessionStart.input.safeParse({ connectionId: "c1", instruction: "" });
    expect(r.success).toBe(false);
  });
  it("accepts a valid request", () => {
    const r = agentCodingSessionStart.input.safeParse({ connectionId: "c1", instruction: "do x" });
    expect(r.success).toBe(true);
  });
  it("is async + high risk + no approval (full autonomy)", () => {
    expect(agentCodingSessionStart.mode).toBe("async");
    expect(agentCodingSessionStart.agent?.riskLevel).toBe("high");
    expect(agentCodingSessionStart.agent?.requiresApproval).toBe(false);
  });
});
```

- [ ] **Step 4: Regenerate contracts + verify manifest**
```bash
pnpm check:contracts
pnpm check:manifest
pnpm --filter @oxagen/oxagen test:unit -- agent.coding.session.test.ts
```
Expected: contracts generate; manifest shows the three new capabilities (api/mcp gaps will close in Task 10).

- [ ] **Step 5: Commit**
```bash
git add packages/oxagen/src/contracts
git commit -m "feat(contracts): agent.coding.session.{start,get,cancel}"
```

---

## Task 9: Handlers + Inngest orchestrator

**Files:**
- Create: `packages/handlers/src/agent.coding.session.start.ts`
- Create: `packages/handlers/src/agent.coding.session.get.ts`
- Create: `packages/handlers/src/agent.coding.session.cancel.ts`
- Modify: `packages/handlers/src/register.ts` (three lazy registrations)
- Modify: `packages/inngest-functions/src/inngest.ts` (two events)
- Create: `packages/inngest-functions/src/functions/agent.coding-session.execute.ts`
- Modify: `packages/inngest-functions/src/functions/index.ts` (register)
- Test: `packages/handlers/src/agent.coding.session.start.test.ts`
- Test: `packages/inngest-functions/src/functions/agent.coding-session.execute.test.ts`

**Interfaces:**
- `start` handler: inserts a `coding_sessions` row (status `pending`, via `withTenantDb`), sends `agent/coding.session.start` event with `{ orgId, workspaceId, sessionId, connectionId, instruction, baseBranch, maxSteps }`, updates row with `inngestRunId`, returns `{ sessionId, inngestRunId }`. (Verbatim shape of `agent.task.background.start` handler.)
- `get` handler: reads the row + ordered events via `withTenantDb`, maps to the contract output (timestamps → ISO strings).
- `cancel` handler: sends `agent/coding.session.cancel` event, sets row status `cancelled`, returns `{ sessionId, status: "cancelled" }`.
- Inngest `agent.coding-session.execute`: `concurrency { limit: 3, key: "event.data.orgId" }`, `retries: 0`, `cancelOn: [{ event: "agent/coding.session.cancel", if: "event.data.sessionId == async.data.sessionId && event.data.orgId == async.data.orgId" }]`. Steps (each DB step wrapped in `runInTenantScope`):
  1. `mark-running`.
  2. `resolve-connection` — read `source_connections` + the linked `oauth_accounts`, **KMS-decrypt** the token (via `@oxagen/crypto`/credential service), derive `{ owner, repo, defaultBranch }` from `deliveryConfig`. Fail closed with `failureReason` if not `connected` or token missing.
  3. `run-agent` — **not** a `step.run` (it streams; runs in the function body): guard `isSandboxAvailable()` (else mark failed "sandbox disabled"); `const handle = await getSandbox().createWorkspace({ networkPolicy: "allow", timeoutMs })`; `await handle.exec("git clone --depth 1 --branch <base> https://x-access-token:<token>@github.com/<owner>/<repo>.git /repo")`; `const ws = new SandboxWorkspace(handle, "/repo")`; `await runCodingAgent({ workspace: ws, instruction, model: <resolved>, maxSteps, codeGraph: <Neo4j provider for connectionId>, onEvent: (e) => persistEvent(...) })`; capture `{ diff, changedFiles, text }`; `await handle.stop()` in `finally`. Persist each event by appending to `coding_session_events` (batch/throttle writes; e.g. flush every N events or on tool/diff events).
  4. `finalize` — update row `status: "completed"`, `diff`, `changedFiles`, `summary: text.slice(0, 2000)`, `completedAt`.
  - On any throw: `mark-failed` with `failureReason`, ensure `handle.stop()`.
- The token MUST be redacted from any persisted event/log (`x-access-token:<token>` never written to `coding_session_events`).

- [ ] **Step 1: Write the `start` handler test** (mock `withTenantDb` + event client; assert a row insert and an event send). Run → FAIL.

- [ ] **Step 2: Implement the three handlers** (verbatim `agent.task.background.start` handler shape). Register all three in `register.ts` with lazy imports.

- [ ] **Step 3: Add the two Inngest events** to `inngest.ts` `Events` type with the data shapes above.

- [ ] **Step 4: Write the orchestrator test** `agent.coding-session.execute.test.ts` — inject a fake sandbox driver via `setSandboxForTests(...)` and a stubbed `runCodingAgent` (mock `@oxagen/coding-agent`), assert: clone command includes the token, `SandboxWorkspace` used, row finalized `completed` with the diff, `handle.stop()` called, and the persisted events never contain the raw token. Run → FAIL.

- [ ] **Step 5: Implement `agent.coding-session.execute.ts`** (createFunction shape verbatim from `agent.background-task.execute.ts`; steps as specified; `runInTenantScope` around every DB step). Register in `functions/index.ts`.

- [ ] **Step 6: Run the new tests + typecheck**
```bash
pnpm --filter @oxagen/handlers test:unit -- agent.coding.session.start.test.ts
pnpm --filter @oxagen/inngest-functions test:unit -- agent.coding-session.execute.test.ts
pnpm --filter @oxagen/handlers typecheck && pnpm --filter @oxagen/inngest-functions typecheck
```
Expected: PASS.

- [ ] **Step 7: Commit**
```bash
git add packages/handlers packages/inngest-functions
git commit -m "feat(coding): session handlers + sandboxed Inngest orchestrator"
```

---

## Task 10: Surfaces — MCP tools, API route, CLI command (parity)

**Files:**
- Create: `apps/mcp/src/tools/agent.coding.session.start.ts`, `.get.ts`, `.cancel.ts`
- Create: `apps/api/src/routes/v1/agent.coding.ts`; Modify: `apps/api/src/app.ts` (mount)
- Create: `apps/cli/src/commands/code.ts` (the `oxagen code "<instruction>" --repo <connection>` command); Modify the CLI command registry to register it
- Test: `apps/api/src/routes/v1/agent.coding.test.ts`

**Interfaces:**
- MCP tools: verbatim from the extracted `agent.execution.record.ts` MCP pattern (schema from `contract.input.shape`, metadata, default export calling `invoke(contract.name, args, ctx, { surface: "mcp" })`).
- API route: a Hono router exposing `POST /agent/coding/sessions` (start), `GET /agent/coding/sessions/:id` (get), `POST /agent/coding/sessions/:id/cancel` — each `buildContext` → `invoke(...)` → return parsed output. Mount in `app.ts` alongside the other v1 routes.
- CLI command: `oxagen code` — resolves the workspace/connection, calls the API `POST /agent/coding/sessions`, then polls `GET .../:id` and renders streamed events + the final diff in the terminal.

- [ ] **Step 1: Write the API route test** `agent.coding.test.ts` (mock `invoke`; assert 200 + output shape for start/get, 4xx on missing fields). Run → FAIL.
- [ ] **Step 2: Implement the three MCP tool files** (one per capability).
- [ ] **Step 3: Implement the API route + mount in `app.ts`.**
- [ ] **Step 4: Implement the CLI `code` command** (reuse the CLI's existing API client + the streamed-render helpers used by other commands).
- [ ] **Step 5: Verify parity + tests**
```bash
pnpm check:manifest
pnpm --filter @oxagen/api test:unit -- agent.coding.test.ts
pnpm --filter @oxagen/api typecheck && pnpm --filter @oxagen/mcp typecheck && pnpm --filter @oxagen/cli typecheck
```
Expected: manifest shows api+mcp+cli covered for all three capabilities; tests PASS.
- [ ] **Step 6: Commit**
```bash
git add apps/mcp apps/api apps/cli
git commit -m "feat(coding): MCP + API + CLI surfaces for agent.coding.session.*"
```

---

## Task 11: In-app surface — coding session in the chat background-task tray

**Files:**
- Modify: `apps/app/src/components/chat/background-task-tray.tsx` (render a coding-session card with status + changed-file count + a "view diff" affordance)
- Create: `apps/app/src/components/chat/coding-session-diff.tsx` (a read-only unified-diff viewer using `@/components/ui/*`)
- Modify: `apps/app/src/app/api/v1/chat/stream/translate-stream.ts` (if needed, map the coding `background-task` event so the tray recognizes `kind: "coding"`)
- Test: `apps/app/src/components/chat/coding-session-diff.test.tsx`
- E2E: `apps/app/e2e/coding-session.spec.ts` + screenshots

**Interfaces:**
- The in-app agent already calls `agent.coding.session.start` as an async tool (it is materialized via the "agent" surface — verify it appears in `materializeTools`). The existing tray polls `agent.coding.session.get` (same shape as `agent.task.background.read`). The new diff card consumes `{ status, changedFiles, diff }` from the poll result.

- [ ] **Step 1: Write the diff-viewer component test** (`coding-session-diff.test.tsx`): renders added/removed lines from a sample unified diff with correct roles/classes. Run → FAIL.
- [ ] **Step 2: Implement `coding-session-diff.tsx`** (pure presentational; parse `+`/`-`/context lines; cite changed files by path, never a UUID).
- [ ] **Step 3: Wire the tray** to render the diff card when `kind === "coding"` and status is terminal; show live event text while running.
- [ ] **Step 4: Component test PASS.**
- [ ] **Step 5: E2E** — seed a connected repo (fixture) + a stubbed sandbox/engine (so CI doesn't hit GitHub/Vercel Sandbox); drive chat → start a coding session → assert the tray shows a non-empty diff; screenshot to `apps/app/e2e/screenshots/`. Delete+recreate the screenshots dir each run; ensure it's gitignored.
```bash
pnpm --filter @oxagen/app test:unit -- coding-session-diff.test.tsx
# E2E per the app's existing playwright invocation (single spec):
pnpm --filter @oxagen/app exec playwright test e2e/coding-session.spec.ts
```
- [ ] **Step 6: Commit**
```bash
git add apps/app
git commit -m "feat(app): coding session diff card in chat background-task tray"
```

---

## Task 12: Docs, manifest sync, and Phase-1 gate

**Files:**
- Create: `docs/capabilities/agent.coding.session.start.md`, `.get.md`, `.cancel.md`; Modify: `docs/capabilities/_index.md`
- Modify: `.env.example` (document `SANDBOX_ENABLED`, `SANDBOX_DRIVER`, `VERCEL_SANDBOX_*` if not already present)

- [ ] **Step 1: Write the three capability docs** (purpose, input/output, surfaces, risk, example) and add them to `_index.md`.
- [ ] **Step 2: Sync env example + lockfile.**
```bash
pnpm i --no-frozen-lockfile
pnpm env:check
```
- [ ] **Step 3: Dispatch `test-completeness-judge`** over the full diff; re-run until APPROVED.
- [ ] **Step 4: Run the pre-merge gate** (ONLY now, once, for the whole body of work — not per task):
```bash
pnpm build
pnpm gate
```
Expected: lint (0 warnings) + typecheck + coverage + tests + migrations all green. Bump each touched package's coverage threshold up to `min(90, floor(coverage − 2.5))` only if headroom holds.
- [ ] **Step 5: Push + open PR**
```bash
git push
gh pr create --base main --head feat/in-app-coding-agent --title "feat: in-app agentic coding runner (Phase 1)" --body "<summary + spec link + risks + rollback>"
gh run watch
```
- [ ] **Step 6: File Linear follow-ups** for Phase 2 (VCS write layer + OAuth write-scope upgrade), Phase 3 (CI auto-fix loop), `@`-mention UX, and the SSE live token-tail — each with model/effort header, spec link, acceptance checklist (per linear-ticket-discipline).

---

## Phases 2–3 roadmap (NOT in this plan — separate specs/plans)

- **Phase 2 — VCS write layer:** `@oxagen/github` Octokit wrapper; OAuth write-scope upgrade (incremental re-consent on the connection); `repo.pr.open`/`repo.pr.get` contracts; push branch from the sandbox using the user token; open a ready PR. Guard: never push to the default branch.
- **Phase 3 — CI auto-fix loop:** extend `POST /webhooks/github/app` to route `check_run`/`workflow_run` to the active session (currently excluded); on failure, resume the sandbox, feed failing logs to `runCodingAgent`, fix, re-push, cap at N=3; finalize on green or cap. Fully autonomous, no gate.
- **Cross-cutting — `@`-mention UX:** composer `@repo` autocomplete → structured mention resolving to a `connectionId`.

## Self-Review notes

- **Spec coverage:** every Phase-1 spec section maps to a task — engine (T1–T4), CLI convergence (T5), persistent sandbox (T6), DB (T7), contracts (T8), orchestration + KMS token + tenant scope + caps (T9), parity surfaces (T10), in-app streaming via tray (T11), docs/guardrails/gate (T12). Phases 2–3 + `@`-mention are explicitly deferred (matches the spec's phasing).
- **Type consistency:** `Workspace`/`CommandResult`/`CodingEvent`/`RunCodingAgentOptions`/`RunCodingAgentResult` defined in T1 are consumed unchanged in T2–T6, T9; `SandboxWorkspaceHandle` defined in T6 is consumed by `SandboxWorkspace` (T6) and the orchestrator (T9); contract input/output types (T8) are consumed by handlers (T9) and surfaces (T10).
- **Guardrail coverage:** RLS+grants (T7), tenant-scoped steps + KMS decrypt + token redaction + sandbox-availability fail-closed + caps (T9), IAM via high-risk contract + defaultRoles (T8), instrumentation via `@oxagen/ai`/`invoke` telemetry (engine + handlers), metering via `invoke()` (T9/T10).
