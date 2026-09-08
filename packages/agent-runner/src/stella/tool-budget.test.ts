/**
 * #2611: the tool list nobody could see, and the provider cap nothing checked.
 *
 * Both fail against `main`, where neither function existed and a turn sending
 * 271 tools to an OpenAI model was sent anyway.
 */
import { describe, expect, it } from "vitest";
import type { ToolSchema } from "@oxagen/stella-engine-client";
import {
  assertWithinToolLimit,
  measureToolList,
  providerOf,
  PROVIDER_TOOL_LIMITS,
  ToolLimitExceededError,
} from "./tool-budget";

const schema = (name: string): ToolSchema => ({
  name,
  description: `does ${name}`,
  input_schema: { type: "object", properties: {} },
  read_only: true,
});

const many = (n: number): ToolSchema[] =>
  Array.from({ length: n }, (_, i) => schema(`tool_${i}`));

describe("providerOf", () => {
  it("reads the provider half of a gateway slug", () => {
    expect(providerOf("anthropic/claude-fable-5")).toBe("anthropic");
    expect(providerOf("openai/gpt-5")).toBe("openai");
  });

  it("returns undefined for a bare model name, which names no provider", () => {
    expect(providerOf("gpt-5")).toBeUndefined();
    expect(providerOf(undefined)).toBeUndefined();
    expect(providerOf("")).toBeUndefined();
  });

  it("does not treat a leading slash as a provider", () => {
    expect(providerOf("/gpt-5")).toBeUndefined();
  });
});

describe("measureToolList", () => {
  it("counts the tools and the exact bytes of what goes on the wire", () => {
    const size = measureToolList(many(3));
    expect(size.count).toBe(3);
    expect(size.bytes).toBe(Buffer.byteLength(JSON.stringify(many(3)), "utf8"));
  });

  it("estimates tokens as bytes/4, which is why it is called an estimate", () => {
    const size = measureToolList(many(10));
    expect(size.estimatedTokens).toBe(Math.round(size.bytes / 4));
  });

  it("reports zero for a turn advertising nothing", () => {
    expect(measureToolList([])).toEqual({
      count: 0,
      bytes: 2,
      estimatedTokens: 1,
    });
  });
});

describe("assertWithinToolLimit (#2611)", () => {
  it("refuses an OpenAI turn over the documented 128", () => {
    // The outage this exists for: 271 tools sent to a provider that takes 128.
    expect(() => assertWithinToolLimit("openai/gpt-5", many(271))).toThrow(
      ToolLimitExceededError,
    );
  });

  it("says which provider, what the cap is, and how many were asked for", () => {
    // A clear, loud error -- not a generic crash, which is the other half of
    // what the issue asks for.
    try {
      assertWithinToolLimit("openai/gpt-5", many(271));
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolLimitExceededError);
      const e = err as ToolLimitExceededError;
      expect(e.provider).toBe("openai");
      expect(e.limit).toBe(128);
      expect(e.count).toBe(271);
      expect(e.message).toContain("openai");
      expect(e.message).toContain("128");
      expect(e.message).toContain("271");
    }
  });

  it("allows exactly the cap, which is not over it", () => {
    expect(() =>
      assertWithinToolLimit("openai/gpt-5", many(128)),
    ).not.toThrow();
  });

  it("does not invent a cap for a provider that publishes none", () => {
    // Refusing a turn that would have worked is worse than not checking.
    expect(PROVIDER_TOOL_LIMITS["anthropic"]).toBeUndefined();
    expect(() =>
      assertWithinToolLimit("anthropic/claude-fable-5", many(271)),
    ).not.toThrow();
  });

  it("does not check a model that names no provider", () => {
    expect(() => assertWithinToolLimit("gpt-5", many(271))).not.toThrow();
    expect(() => assertWithinToolLimit(undefined, many(271))).not.toThrow();
  });
});
