import { describe, it, expect } from "vitest";
import {
  parseStoredCodeBinding,
  resolveCodeBinding,
  toStoredCodeBinding,
  type RequestedCodePayload,
  type StoredCodeBinding,
} from "./code-binding";

function payload(
  overrides: Partial<RequestedCodePayload> = {},
): RequestedCodePayload {
  return {
    connectionId: "con_1",
    owner: "oxageninc",
    name: "oxagen-platform",
    defaultBranch: "main",
    environmentId: "env_1",
    environmentName: "Production",
    sandboxSessionId: null,
    ...overrides,
  };
}

function stored(overrides: Partial<StoredCodeBinding> = {}): StoredCodeBinding {
  return {
    version: 1,
    agentId: "agt_code",
    connectionId: "con_1",
    owner: "oxageninc",
    name: "oxagen-platform",
    defaultBranch: "main",
    environmentId: "env_1",
    environmentName: "Production",
    ...overrides,
  };
}

describe("parseStoredCodeBinding", () => {
  it("parses a valid v1 binding", () => {
    expect(parseStoredCodeBinding(stored())).toEqual(stored());
  });

  it("returns null for null/undefined (unbound conversation)", () => {
    expect(parseStoredCodeBinding(null)).toBeNull();
    expect(parseStoredCodeBinding(undefined)).toBeNull();
  });

  it("returns null (never throws) for a corrupt or future-version shape", () => {
    expect(parseStoredCodeBinding({ garbage: true })).toBeNull();
    expect(parseStoredCodeBinding({ ...stored(), version: 2 })).toBeNull();
    expect(parseStoredCodeBinding("not-an-object")).toBeNull();
  });
});

describe("toStoredCodeBinding", () => {
  it("builds a v1 binding from the payload + agent, dropping the session hint", () => {
    const binding = toStoredCodeBinding(
      payload({ sandboxSessionId: "sbx_warm" }),
      "agt_code",
    );
    expect(binding).toEqual(stored());
    expect("sandboxSessionId" in binding).toBe(false);
  });
});

describe("resolveCodeBinding", () => {
  it("passes the request through untouched when no binding is stored", () => {
    const result = resolveCodeBinding({
      stored: null,
      requestedAgentId: "agt_x",
      requestedCode: payload(),
    });
    expect(result).toEqual({
      agentId: "agt_x",
      code: payload(),
      warnings: [],
    });
  });

  it("locks agent + repo/env to the stored binding for every later turn", () => {
    const result = resolveCodeBinding({
      stored: stored(),
      requestedAgentId: "agt_code",
      requestedCode: payload({ sandboxSessionId: "sbx_warm" }),
    });
    expect(result.agentId).toBe("agt_code");
    expect(result.code).toEqual(payload({ sandboxSessionId: "sbx_warm" }));
    expect(result.warnings).toEqual([]);
  });

  it("supplies the bound agent + code payload even when the client sends neither (stale client)", () => {
    const result = resolveCodeBinding({
      stored: stored(),
      requestedAgentId: null,
      requestedCode: null,
    });
    expect(result.agentId).toBe("agt_code");
    expect(result.code).toEqual(payload({ sandboxSessionId: null }));
    expect(result.warnings).toEqual([]);
  });

  it("overrides a different requested repo with the binding and warns", () => {
    const result = resolveCodeBinding({
      stored: stored(),
      requestedAgentId: "agt_code",
      requestedCode: payload({
        name: "other-repo",
        sandboxSessionId: "sbx_other",
      }),
    });
    expect(result.code?.name).toBe("oxagen-platform");
    // A warm-session hint minted for a DIFFERENT repo must not reconnect.
    expect(result.code?.sandboxSessionId).toBeNull();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("oxageninc/oxagen-platform");
  });

  it("overrides a different requested agent with the binding and warns", () => {
    const result = resolveCodeBinding({
      stored: stored(),
      requestedAgentId: "agt_other",
      requestedCode: payload(),
    });
    expect(result.agentId).toBe("agt_code");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("locked to the agent");
  });

  it("overrides a different requested environment with the binding and warns", () => {
    const result = resolveCodeBinding({
      stored: stored(),
      requestedAgentId: "agt_code",
      requestedCode: payload({ environmentId: "env_other" }),
    });
    expect(result.code?.environmentId).toBe("env_1");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("environment");
  });

  it("accumulates one warning per overridden value", () => {
    const result = resolveCodeBinding({
      stored: stored(),
      requestedAgentId: "agt_other",
      requestedCode: payload({ owner: "someone-else", environmentId: "env_2" }),
    });
    expect(result.warnings).toHaveLength(3);
  });
});
