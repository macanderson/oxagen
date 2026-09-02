/**
 * Unit tests for sandbox policy enforcement.
 *
 * `applyPolicy` is the runtime gate that validates every SandboxRequest
 * before it reaches Docker/Modal. These tests cover the four boundary
 * conditions that make it security-critical:
 *
 *   1. Network deny — request with network="allow" is rejected when policy
 *      disallows network.
 *   2. Language denylist — language absent from allowedLanguages is rejected.
 *   3. Value clamping — timeoutMs/memoryMb are clamped to policy ceilings,
 *      never silently raised.
 *   4. Edge values — zero/exactly-at-limit values handled correctly.
 *
 * No external dependencies; pure function tests only.
 */
import { describe, it, expect } from "vitest";
import {
  applyPolicy,
  SandboxPolicyError,
  DEFAULT_POLICY,
  type SandboxPolicy,
} from "./policy";
import type { SandboxRequest } from "./types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<SandboxRequest> = {}): SandboxRequest {
  return {
    language: "node",
    code: 'console.log("hi")',
    timeoutMs: 5_000,
    memoryMb: 128,
    network: "deny",
    orgId: "org_test",
    workspaceId: "wrk_test",
    ...overrides,
  };
}

const FULL_POLICY: SandboxPolicy = {
  allowedLanguages: ["node", "python", "shell"],
  maxTimeoutMs: 30_000,
  maxMemoryMb: 512,
  allowNetwork: false,
};

const NETWORK_POLICY: SandboxPolicy = {
  ...FULL_POLICY,
  allowNetwork: true,
};

const NODE_ONLY_POLICY: SandboxPolicy = {
  ...FULL_POLICY,
  allowedLanguages: ["node"],
};

// ---------------------------------------------------------------------------
// Network boundary
// ---------------------------------------------------------------------------

describe("applyPolicy — network", () => {
  it("passes a request with network=deny when policy disallows network", () => {
    const req = makeReq({ network: "deny" });
    const result = applyPolicy(req, FULL_POLICY);
    expect(result.network).toBe("deny");
  });

  it("throws SandboxPolicyError when request wants network but policy denies it", () => {
    const req = makeReq({ network: "allow" });
    expect(() => applyPolicy(req, FULL_POLICY)).toThrow(SandboxPolicyError);
  });

  it("error message names the network violation", () => {
    const req = makeReq({ network: "allow" });
    expect(() => applyPolicy(req, FULL_POLICY)).toThrow(
      /network access not allowed by policy/,
    );
  });

  it("allows network=allow when policy permits network", () => {
    const req = makeReq({ network: "allow" });
    const result = applyPolicy(req, NETWORK_POLICY);
    expect(result.network).toBe("allow");
  });

  it("does not throw for network=deny even when policy allows network", () => {
    const req = makeReq({ network: "deny" });
    const result = applyPolicy(req, NETWORK_POLICY);
    expect(result.network).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// Language denylist
// ---------------------------------------------------------------------------

describe("applyPolicy — language denylist", () => {
  it("throws SandboxPolicyError when language is not in allowedLanguages", () => {
    const req = makeReq({ language: "python" });
    expect(() => applyPolicy(req, NODE_ONLY_POLICY)).toThrow(
      SandboxPolicyError,
    );
  });

  it("error message names the disallowed language", () => {
    const req = makeReq({ language: "python" });
    expect(() => applyPolicy(req, NODE_ONLY_POLICY)).toThrow(/python/);
  });

  it("passes when language is in allowedLanguages", () => {
    const req = makeReq({ language: "node" });
    expect(() => applyPolicy(req, NODE_ONLY_POLICY)).not.toThrow();
  });

  it("passes every language that appears in the full policy list", () => {
    for (const lang of FULL_POLICY.allowedLanguages) {
      const req = makeReq({ language: lang });
      expect(() => applyPolicy(req, FULL_POLICY)).not.toThrow();
    }
  });

  it("rejects a language not on the DEFAULT_POLICY list (shell is allowed, but typed wrong)", () => {
    // "bash" is not a SandboxLanguage; coercing via unknown to test runtime guard.
    const req = makeReq({ language: "bash" as unknown as "shell" });
    expect(() => applyPolicy(req, FULL_POLICY)).toThrow(SandboxPolicyError);
  });
});

// ---------------------------------------------------------------------------
// Value clamping — timeoutMs
// ---------------------------------------------------------------------------

describe("applyPolicy — timeoutMs clamping", () => {
  it("clamps timeoutMs to maxTimeoutMs when request exceeds the ceiling", () => {
    const req = makeReq({ timeoutMs: 999_999 });
    const result = applyPolicy(req, FULL_POLICY);
    expect(result.timeoutMs).toBe(FULL_POLICY.maxTimeoutMs);
  });

  it("preserves timeoutMs when it is below the ceiling", () => {
    const req = makeReq({ timeoutMs: 1_000 });
    const result = applyPolicy(req, FULL_POLICY);
    expect(result.timeoutMs).toBe(1_000);
  });

  it("preserves timeoutMs when it equals the ceiling exactly", () => {
    const req = makeReq({ timeoutMs: FULL_POLICY.maxTimeoutMs });
    const result = applyPolicy(req, FULL_POLICY);
    expect(result.timeoutMs).toBe(FULL_POLICY.maxTimeoutMs);
  });

  it("clamps timeoutMs of 1ms above ceiling down to ceiling", () => {
    const req = makeReq({ timeoutMs: FULL_POLICY.maxTimeoutMs + 1 });
    const result = applyPolicy(req, FULL_POLICY);
    expect(result.timeoutMs).toBe(FULL_POLICY.maxTimeoutMs);
  });
});

// ---------------------------------------------------------------------------
// Value clamping — memoryMb
// ---------------------------------------------------------------------------

describe("applyPolicy — memoryMb clamping", () => {
  it("clamps memoryMb to maxMemoryMb when request exceeds the ceiling", () => {
    const req = makeReq({ memoryMb: 99_999 });
    const result = applyPolicy(req, FULL_POLICY);
    expect(result.memoryMb).toBe(FULL_POLICY.maxMemoryMb);
  });

  it("preserves memoryMb when it is below the ceiling", () => {
    const req = makeReq({ memoryMb: 64 });
    const result = applyPolicy(req, FULL_POLICY);
    expect(result.memoryMb).toBe(64);
  });

  it("preserves memoryMb when it equals the ceiling exactly", () => {
    const req = makeReq({ memoryMb: FULL_POLICY.maxMemoryMb });
    const result = applyPolicy(req, FULL_POLICY);
    expect(result.memoryMb).toBe(FULL_POLICY.maxMemoryMb);
  });

  it("clamps memoryMb of 1 above ceiling down to ceiling", () => {
    const req = makeReq({ memoryMb: FULL_POLICY.maxMemoryMb + 1 });
    const result = applyPolicy(req, FULL_POLICY);
    expect(result.memoryMb).toBe(FULL_POLICY.maxMemoryMb);
  });
});

// ---------------------------------------------------------------------------
// Edge values
// ---------------------------------------------------------------------------

describe("applyPolicy — edge values", () => {
  it("allows timeoutMs=0 and memoryMb=0 (pass-through, not clamped up)", () => {
    const req = makeReq({ timeoutMs: 0, memoryMb: 0 });
    const result = applyPolicy(req, FULL_POLICY);
    // Math.min(0, ceiling) === 0; ensure we don't accidentally raise the value.
    expect(result.timeoutMs).toBe(0);
    expect(result.memoryMb).toBe(0);
  });

  it("preserves all other SandboxRequest fields unchanged", () => {
    const req = makeReq({
      code: "test_code",
      stdin: "hello",
      env: { FOO: "bar" },
      orgId: "org_original",
      workspaceId: "wrk_original",
    });
    const result = applyPolicy(req, FULL_POLICY);
    expect(result.code).toBe("test_code");
    expect(result.stdin).toBe("hello");
    expect(result.env).toEqual({ FOO: "bar" });
    expect(result.orgId).toBe("org_original");
    expect(result.workspaceId).toBe("wrk_original");
  });

  it("returns a new object, not the same reference", () => {
    const req = makeReq();
    const result = applyPolicy(req, FULL_POLICY);
    expect(result).not.toBe(req);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_POLICY invariants
// ---------------------------------------------------------------------------

describe("DEFAULT_POLICY constants", () => {
  it("has network disabled by default", () => {
    expect(DEFAULT_POLICY.allowNetwork).toBe(false);
  });

  it("allows node, python, and shell by default", () => {
    expect(DEFAULT_POLICY.allowedLanguages).toContain("node");
    expect(DEFAULT_POLICY.allowedLanguages).toContain("python");
    expect(DEFAULT_POLICY.allowedLanguages).toContain("shell");
  });

  it("maxTimeoutMs is positive", () => {
    expect(DEFAULT_POLICY.maxTimeoutMs).toBeGreaterThan(0);
  });

  it("maxMemoryMb is positive", () => {
    expect(DEFAULT_POLICY.maxMemoryMb).toBeGreaterThan(0);
  });
});
