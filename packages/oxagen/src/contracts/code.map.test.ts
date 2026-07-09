import { describe, expect, it } from "vitest";
import { codeMap } from "./code.map";
import { getCapability } from "../registry";

describe("code.map capability", () => {
  it("accepts a minimal valid input", () => {
    const parsed = codeMap.input.parse({ query: "payments" });
    expect(parsed.query).toBe("payments");
    expect(parsed.limit).toBe(20); // default
  });

  it("defaults limit to 20", () => {
    const parsed = codeMap.input.parse({ query: "auth" });
    expect(parsed.limit).toBe(20);
  });

  it("accepts an explicit limit", () => {
    const parsed = codeMap.input.parse({ query: "billing", limit: 5 });
    expect(parsed.limit).toBe(5);
  });

  it("rejects a limit above 50", () => {
    expect(() => codeMap.input.parse({ query: "x", limit: 51 })).toThrow();
  });

  it("rejects a limit below 1", () => {
    expect(() => codeMap.input.parse({ query: "x", limit: 0 })).toThrow();
  });

  it("rejects a non-integer limit", () => {
    expect(() => codeMap.input.parse({ query: "x", limit: 1.5 })).toThrow();
  });

  it("rejects an empty query", () => {
    expect(() => codeMap.input.parse({ query: "" })).toThrow();
  });

  it("rejects a query over 1000 chars", () => {
    expect(() => codeMap.input.parse({ query: "a".repeat(1001) })).toThrow();
  });

  it("accepts a valid kinds filter", () => {
    const parsed = codeMap.input.parse({
      query: "auth",
      kinds: ["file", "symbol"],
    });
    expect(parsed.kinds).toEqual(["file", "symbol"]);
  });

  it("rejects an invalid kind value", () => {
    expect(() =>
      codeMap.input.parse({ query: "x", kinds: ["invalid" as "file"] }),
    ).toThrow();
  });

  it("accepts a domain filter", () => {
    const parsed = codeMap.input.parse({ query: "payments", domain: "billing" });
    expect(parsed.domain).toBe("billing");
  });

  it("parses a valid empty output bundle", () => {
    const parsed = codeMap.output.parse({
      files: [],
      symbols: [],
      calls: [],
      recentChanges: [],
    });
    expect(parsed.files).toEqual([]);
    expect(parsed.symbols).toEqual([]);
    expect(parsed.calls).toEqual([]);
    expect(parsed.recentChanges).toEqual([]);
  });

  it("parses a full output bundle with all fields", () => {
    const parsed = codeMap.output.parse({
      files: [
        {
          nodeId: "f-1",
          path: "src/billing/stripe.ts",
          language: "typescript",
          displayName: "stripe.ts",
          domain: "billing",
          score: 0.95,
        },
      ],
      symbols: [
        {
          nodeId: "s-1",
          name: "createPaymentIntent",
          kind: "function",
          path: "src/billing/stripe.ts",
          startLine: 10,
          endLine: 40,
          signature: "async function createPaymentIntent(amount: number)",
          docComment: "Creates a Stripe payment intent",
          domain: "billing",
          score: 1.0,
        },
      ],
      calls: [
        {
          callerNodeId: "s-1",
          calleeNodeId: "s-2",
          callerName: "createPaymentIntent",
          calleeName: "validateAmount",
        },
      ],
      recentChanges: [
        {
          commitSha: "abc123",
          message: "fix: billing rounding",
          authorName: "Alice",
          committedAt: "2026-06-20T12:00:00Z",
          modifiedFiles: ["src/billing/stripe.ts"],
        },
      ],
    });

    expect(parsed.files[0]?.nodeId).toBe("f-1");
    expect(parsed.symbols[0]?.name).toBe("createPaymentIntent");
    expect(parsed.calls[0]?.callerName).toBe("createPaymentIntent");
    expect(parsed.recentChanges[0]?.commitSha).toBe("abc123");
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("get_code_map")).toBe(codeMap);
  });

  it("declares the api, mcp, agent, and cli surfaces", () => {
    expect(codeMap.surfaces).toEqual(["api", "mcp", "agent", "cli"]);
  });

  it("is scoped (tenant + workspace)", () => {
    expect(codeMap.scoped).toBe(true);
  });
});
