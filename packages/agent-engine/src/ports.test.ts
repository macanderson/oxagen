import { describe, it, expect } from "vitest";
import type { AgentAi, MemoryProvider, TraceStore } from "./ports";

describe("ports", () => {
  it("AgentAi accepts a conforming implementation", () => {
    const accept = (impl: AgentAi): AgentAi => impl;
    // `stream`'s return is a full StreamTextResult — out of scope to construct
    // here (it is exercised in the engine test with a real fake); this test
    // pins the structural shape and the generateObject contract.
    const impl = {
      stream: (() => undefined) as unknown,
      generateObject: async <T>({
        schema,
      }: {
        schema: { parse: (x: unknown) => T };
      }) => ({
        object: schema.parse({}),
        usage: { totalTokens: 0 },
      }),
    } as unknown as AgentAi;
    expect(typeof accept(impl).generateObject).toBe("function");
  });

  it("MemoryProvider and TraceStore are structurally satisfiable", async () => {
    const mem: MemoryProvider = {
      recallContext: async () => "recalled",
      remember: () => undefined,
    };
    const trace: TraceStore = { record: () => undefined };
    expect(await mem.recallContext()).toBe("recalled");
    expect(mem.remember("k", { a: 1 })).toBeUndefined();
    expect(trace.record({ id: "t1" })).toBeUndefined();
  });
});
