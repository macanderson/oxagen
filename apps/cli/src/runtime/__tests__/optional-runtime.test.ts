import { describe, it, expect } from "vitest";
import {
  isOptionalDepInstalled,
  loadOptionalRuntime,
} from "../provisioning/optional-runtime.js";

/** A structural stand-in for the node-llama-cpp v3 module. */
function fakeLlamaModule() {
  return {
    getLlama: async () => ({
      loadModel: async (_opts: { modelPath: string }) => ({
        tokenize: (t: string) => ({
          length: t.trim() ? t.trim().split(/\s+/).length : 0,
        }),
        createContext: async () => ({ getSequence: () => ({}) }),
        dispose: async () => {},
      }),
    }),
    LlamaChatSession: class {
      constructor(_opts: { contextSequence: unknown }) {}
      async prompt(text: string) {
        return `ANSWER: ${text}`;
      }
    },
  };
}

describe("loadOptionalRuntime", () => {
  it("returns null when the dependency is not installed (import throws)", async () => {
    const rt = await loadOptionalRuntime(async () => {
      throw new Error("Cannot find module 'node-llama-cpp'");
    });
    expect(rt).toBeNull();
  });

  it("returns null when the module is absent or malformed", async () => {
    expect(await loadOptionalRuntime(async () => null)).toBeNull();
    expect(await loadOptionalRuntime(async () => ({}))).toBeNull(); // no getLlama
  });

  it("adapts a present runtime and runs a completion", async () => {
    const rt = await loadOptionalRuntime(async () => fakeLlamaModule());
    expect(rt).not.toBeNull();
    expect(rt!.name).toBe("node-llama-cpp");

    const model = await rt!.load("/weights/model.gguf");
    const res = await model.complete({
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi there friend" },
      ],
      maxOutputTokens: 32,
      temperature: 0.2,
    });
    expect(res.text).toBe("ANSWER: hi there friend");
    expect(res.usage.inputTokens).toBe(3); // "hi there friend"
    expect(res.usage.outputTokens).toBe(4); // "ANSWER: hi there friend"
    await model.dispose();
  });
});

describe("isOptionalDepInstalled", () => {
  it("is false when the loader yields nothing", async () => {
    expect(await isOptionalDepInstalled(async () => null)).toBe(false);
  });
  it("is true when a valid runtime loads", async () => {
    expect(await isOptionalDepInstalled(async () => fakeLlamaModule())).toBe(
      true,
    );
  });
});
