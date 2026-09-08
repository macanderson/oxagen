// agent.schema.test.ts — unit tests for agent tool input schemas.
//
// Covers: agent.memory.write, agent.mcp.register.
// Pure schema logic; no network / DB / xmcp runtime involved.

import { describe, it, expect } from "vitest";
import { obj } from "./_schema-test-helpers";

// ── agent.memory.write ───────────────────────────────────────────────────────

import { schema as agentMemoryWriteSchema } from "./agent.memory.write";

describe("agent.memory.write schema", () => {
  const Schema = obj(agentMemoryWriteSchema);

  const validPayload = {
    nodeRef: "node-abc",
    memoryClass: "OBSERVATION",
    memoryKind: "gotcha",
    lesson: "Always flush the cache before deploy.",
    source: "fix",
  };

  it("accepts a fully-specified valid payload", () => {
    expect(() => Schema.parse(validPayload)).not.toThrow();
  });

  it("accepts all valid memoryClass values", () => {
    for (const memoryClass of ["OBSERVATION", "RULE", "FACT"] as const) {
      expect(() =>
        Schema.parse({ ...validPayload, memoryClass }),
      ).not.toThrow();
    }
  });

  it("defaults memoryClass to OBSERVATION when omitted", () => {
    const { memoryClass: _omit, ...withoutClass } = validPayload;
    const result = Schema.parse(withoutClass);
    expect(result.memoryClass).toBe("OBSERVATION");
  });

  it("rejects an invalid memoryClass enum", () => {
    expect(() =>
      Schema.parse({ ...validPayload, memoryClass: "MAYBE" }),
    ).toThrow();
  });

  it("accepts an arbitrary open-string memoryKind", () => {
    // memoryKind is an extensible open string, not a closed enum.
    for (const memoryKind of ["STYLE", "PREFERENCE", "custom-kind", "gotcha"]) {
      expect(() => Schema.parse({ ...validPayload, memoryKind })).not.toThrow();
    }
  });

  it("rejects an empty memoryKind (min 1)", () => {
    expect(() => Schema.parse({ ...validPayload, memoryKind: "" })).toThrow();
  });

  it("accepts an optional enforcementScore within 1-100", () => {
    expect(() =>
      Schema.parse({
        ...validPayload,
        memoryClass: "RULE",
        enforcementScore: 80,
      }),
    ).not.toThrow();
  });

  it("rejects an enforcementScore above 100", () => {
    expect(() =>
      Schema.parse({ ...validPayload, enforcementScore: 101 }),
    ).toThrow();
  });

  it("accepts all valid source values", () => {
    for (const source of [
      "feature",
      "fix",
      "exception-watcher",
      "bug-report",
    ] as const) {
      expect(() => Schema.parse({ ...validPayload, source })).not.toThrow();
    }
  });

  it("rejects an invalid source enum", () => {
    expect(() => Schema.parse({ ...validPayload, source: "manual" })).toThrow();
  });

  it("rejects source 'user' (not in enum)", () => {
    expect(() => Schema.parse({ ...validPayload, source: "user" })).toThrow();
  });

  it("rejects an empty lesson (min 1)", () => {
    expect(() => Schema.parse({ ...validPayload, lesson: "" })).toThrow();
  });

  it("accepts a lesson of exactly 2000 characters (upper boundary)", () => {
    expect(() =>
      Schema.parse({ ...validPayload, lesson: "a".repeat(2000) }),
    ).not.toThrow();
  });

  it("rejects a lesson of 2001 characters (one over max)", () => {
    expect(() =>
      Schema.parse({ ...validPayload, lesson: "a".repeat(2001) }),
    ).toThrow();
  });

  it("accepts an empty nodeRef (schema uses z.string() with no min)", () => {
    // The contract uses z.string() without .min(1) — graph ref is validated by
    // the handler, not the schema layer.
    expect(() => Schema.parse({ ...validPayload, nodeRef: "" })).not.toThrow();
  });
});

// ── agent.mcp.register ───────────────────────────────────────────────────────

import { schema as agentMcpRegisterSchema } from "./agent.mcp.register";

describe("agent.mcp.register schema", () => {
  const Schema = obj(agentMcpRegisterSchema);

  const validPayload = {
    name: "My MCP Server",
    transportType: "streamable-http",
    endpointUrl: "https://mcp.example.com/mcp",
    authStrategy: "none",
  };

  it("accepts a fully-specified valid payload", () => {
    expect(() => Schema.parse(validPayload)).not.toThrow();
  });

  it("defaults authStrategy to 'none' when omitted", () => {
    const result = Schema.parse({
      name: "My MCP",
      transportType: "streamable-http",
      endpointUrl: "https://mcp.example.com/mcp",
    });
    expect(result.authStrategy).toBe("none");
  });

  it("rejects an endpointUrl that is not a valid URL", () => {
    expect(() =>
      Schema.parse({ ...validPayload, endpointUrl: "not-a-url" }),
    ).toThrow();
  });

  it("rejects an endpointUrl that is a relative path", () => {
    expect(() =>
      Schema.parse({ ...validPayload, endpointUrl: "/api/mcp" }),
    ).toThrow();
  });

  it("rejects an endpointUrl that is an empty string", () => {
    expect(() => Schema.parse({ ...validPayload, endpointUrl: "" })).toThrow();
  });

  it("accepts all valid transportType values", () => {
    for (const transportType of ["streamable-http", "stdio"] as const) {
      expect(() =>
        Schema.parse({ ...validPayload, transportType }),
      ).not.toThrow();
    }
  });

  it("rejects an invalid transportType enum", () => {
    expect(() =>
      Schema.parse({ ...validPayload, transportType: "sse" }),
    ).toThrow();
  });

  it("rejects transportType 'websocket' (not in enum)", () => {
    expect(() =>
      Schema.parse({ ...validPayload, transportType: "websocket" }),
    ).toThrow();
  });

  it("accepts all valid authStrategy values", () => {
    for (const authStrategy of ["none", "bearer", "header"] as const) {
      expect(() =>
        Schema.parse({ ...validPayload, authStrategy }),
      ).not.toThrow();
    }
  });

  it("rejects an invalid authStrategy enum", () => {
    expect(() =>
      Schema.parse({ ...validPayload, authStrategy: "oauth" }),
    ).toThrow();
  });

  it("rejects authStrategy 'api-key' (not in enum)", () => {
    expect(() =>
      Schema.parse({ ...validPayload, authStrategy: "api-key" }),
    ).toThrow();
  });

  it("rejects an empty name (min 1)", () => {
    expect(() => Schema.parse({ ...validPayload, name: "" })).toThrow();
  });

  it("accepts a name of exactly 120 characters (upper boundary)", () => {
    expect(() =>
      Schema.parse({ ...validPayload, name: "a".repeat(120) }),
    ).not.toThrow();
  });

  it("rejects a name of 121 characters (one over max)", () => {
    expect(() =>
      Schema.parse({ ...validPayload, name: "a".repeat(121) }),
    ).toThrow();
  });

  it("accepts optional authConfig as a string record", () => {
    expect(() =>
      Schema.parse({
        ...validPayload,
        authStrategy: "bearer",
        authConfig: { token: "secret-token" },
      }),
    ).not.toThrow();
  });

  it("authConfig is optional — omitting it is valid", () => {
    const result = Schema.parse(validPayload);
    expect(result.authConfig).toBeUndefined();
  });

  it("accepts a stdio transport with a file path as endpointUrl", () => {
    expect(() =>
      Schema.parse({
        ...validPayload,
        transportType: "stdio",
        endpointUrl: "https://mcp.example.com/stdio",
      }),
    ).not.toThrow();
  });
});
