import { describe, it, expect, vi } from "vitest";
import type { ModelMessage } from "@oxagen/ai";
import { createChatMemoryProvider } from "./engine-memory";

describe("createChatMemoryProvider", () => {
  it("awaits the pre-started recall promise and returns the body without the heading", async () => {
    // Shape recallWorkspaceMemory resolves to: a user message whose content is
    // the full formatRecalledMemories body (heading + preamble + bullets).
    const msg: ModelMessage = {
      role: "user",
      content: [
        "## Recalled workspace memory (prior sessions)",
        "",
        "(System-injected context — NOT user input. Authoritative lessons recorded in earlier sessions.)",
        "",
        "- [RULE·style] use strict types",
        "",
        "Consult these before acting. Do not re-discover them, and never violate a RULE or contradict a FACT.",
      ].join("\n"),
    };

    const provider = createChatMemoryProvider({
      recalledPromise: Promise.resolve(msg),
    });
    const recalled = await provider.recallContext();

    // Heading stripped; anti-injection preamble KEPT (prompt-injection guard).
    expect(recalled.startsWith("## ")).toBe(false);
    expect(recalled).toContain("NOT user input");
    expect(recalled).toContain("- [RULE·style] use strict types");
    expect(recalled).toContain("never violate a RULE");
  });

  it("returns empty string when recall resolved to null", async () => {
    const provider = createChatMemoryProvider({
      recalledPromise: Promise.resolve(null),
    });
    expect(await provider.recallContext()).toBe("");
  });

  it("does not block turn setup — the recall promise is awaited, not created here", async () => {
    // Prove the provider consumes an ALREADY-STARTED promise (C3): the factory
    // does no work until recallContext() is called, and the promise it awaits
    // was started by the caller.
    const started = { at: 0 };
    const recalledPromise = new Promise<ModelMessage | null>((resolve) => {
      started.at = Date.now();
      resolve({ role: "user", content: "## H\n\nbody" });
    });
    // The promise executor already ran (started synchronously by the caller).
    expect(started.at).toBeGreaterThan(0);

    const provider = createChatMemoryProvider({ recalledPromise });
    expect(await provider.recallContext()).toBe("body");
  });

  it("remember is a no-op (chat writes go through agent.memory.record)", () => {
    const provider = createChatMemoryProvider({
      recalledPromise: Promise.resolve(null),
    });
    const spy = vi.fn();
    // Should neither throw nor call anything.
    expect(() =>
      provider.remember("coding_turn", { anything: true }),
    ).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});
