/**
 * Coverage for the partitioned dispatch guard (agent-engine v2 Phase 0):
 * shared-lane cap, exclusive barrier for mutating tools, FIFO fairness around
 * a queued mutation, caller-supplied mutating names, and grant release on
 * throw. House style: dependency injection — handcrafted ToolSets with
 * controlled deferreds; no vi.mock, no timers.
 */
import { describe, it, expect } from "vitest";
import type { ToolSet } from "ai";
import { wrapToolsWithDispatchGuard } from "./dispatch-guard";

type Exec = (input: unknown, options: unknown) => Promise<unknown>;

/** Await pending microtasks so queued grants settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function deferred(): {
  promise: Promise<unknown>;
  resolve: (v?: unknown) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v?: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A tool whose executions block on caller-controlled gates: each call records
 * itself in `started` and awaits its own deferred, so tests decide exactly
 * when each in-flight execution completes.
 */
function blockingTool(started: string[], label: string) {
  const gates: Array<ReturnType<typeof deferred>> = [];
  return {
    gates,
    tool: {
      execute: (async (input: unknown) => {
        started.push(`${label}:${JSON.stringify(input)}`);
        const gate = deferred();
        gates.push(gate);
        return gate.promise;
      }) as Exec,
    },
  };
}

function run(tools: ToolSet, name: string, input: unknown): Promise<unknown> {
  return (tools[name] as { execute: Exec }).execute(input, {});
}

describe("wrapToolsWithDispatchGuard — shared lane", () => {
  it("caps non-mutating concurrency and admits queued calls as slots free", async () => {
    const started: string[] = [];
    const read = blockingTool(started, "read");
    const wrapped = wrapToolsWithDispatchGuard(
      { read_file: read.tool } as unknown as ToolSet,
      { maxConcurrent: 2 },
    );

    const p1 = run(wrapped, "read_file", { n: 1 });
    const p2 = run(wrapped, "read_file", { n: 2 });
    const p3 = run(wrapped, "read_file", { n: 3 });
    await settle();
    expect(started).toHaveLength(2); // third call queues behind the cap

    read.gates[0]!.resolve("a");
    await settle();
    expect(started).toHaveLength(3); // freed slot admits it

    read.gates[1]!.resolve("b");
    read.gates[2]!.resolve("c");
    await expect(Promise.all([p1, p2, p3])).resolves.toEqual(["a", "b", "c"]);
  });

  it("passes schema-only tools through untouched", () => {
    const schemaOnly = { description: "no execute" };
    const wrapped = wrapToolsWithDispatchGuard({
      no_exec: schemaOnly,
    } as unknown as ToolSet);
    expect(wrapped["no_exec"]).toBe(schemaOnly);
  });
});

describe("wrapToolsWithDispatchGuard — exclusive barrier", () => {
  it("a mutating call waits out in-flight reads, runs alone, and fences later reads (FIFO)", async () => {
    const started: string[] = [];
    const read = blockingTool(started, "read");
    const write = blockingTool(started, "write");
    const wrapped = wrapToolsWithDispatchGuard({
      read_file: read.tool,
      write_file: write.tool, // built-in MUTATING_TOOL_NAMES member
    } as unknown as ToolSet);

    void run(wrapped, "read_file", { n: 1 });
    void run(wrapped, "read_file", { n: 2 });
    void run(wrapped, "write_file", { n: 3 });
    void run(wrapped, "read_file", { n: 4 }); // arrives AFTER the mutation
    await settle();
    // Reads run; the mutation waits; the late read queues behind the mutation.
    expect(started).toEqual(['read:{"n":1}', 'read:{"n":2}']);

    read.gates[0]!.resolve();
    await settle();
    expect(started).toHaveLength(2); // one read still in flight — barrier holds

    read.gates[1]!.resolve();
    await settle();
    expect(started[2]).toBe('write:{"n":3}'); // exclusive grant
    expect(started).toHaveLength(3); // the late read is still fenced

    write.gates[0]!.resolve();
    await settle();
    expect(started[3]).toBe('read:{"n":4}');
  });

  it("serializes back-to-back mutations", async () => {
    const started: string[] = [];
    const write = blockingTool(started, "write");
    const wrapped = wrapToolsWithDispatchGuard({
      write_file: write.tool,
    } as unknown as ToolSet);

    void run(wrapped, "write_file", { n: 1 });
    void run(wrapped, "write_file", { n: 2 });
    await settle();
    expect(started).toHaveLength(1);

    write.gates[0]!.resolve();
    await settle();
    expect(started).toHaveLength(2);
  });

  it("honors caller-supplied mutating tool names (capability aliases)", async () => {
    const started: string[] = [];
    const read = blockingTool(started, "read");
    const cap = blockingTool(started, "cap");
    const wrapped = wrapToolsWithDispatchGuard(
      {
        read_file: read.tool,
        delete_records: cap.tool,
      } as unknown as ToolSet,
      { mutatingToolNames: ["delete_records"] },
    );

    void run(wrapped, "read_file", { n: 1 });
    void run(wrapped, "delete_records", { n: 2 });
    await settle();
    expect(started).toHaveLength(1); // capability alias fenced like a mutator

    read.gates[0]!.resolve();
    await settle();
    expect(started[1]).toBe('cap:{"n":2}');
  });

  it("releases the grant when a tool throws, so later calls are not wedged", async () => {
    const started: string[] = [];
    const write = blockingTool(started, "write");
    const wrapped = wrapToolsWithDispatchGuard({
      write_file: write.tool,
    } as unknown as ToolSet);

    const p1 = run(wrapped, "write_file", { n: 1 });
    await settle();
    write.gates[0]!.reject(new Error("boom"));
    await expect(p1).rejects.toThrow("boom");

    void run(wrapped, "write_file", { n: 2 });
    await settle();
    expect(started).toHaveLength(2); // grant was released despite the throw
  });
});
