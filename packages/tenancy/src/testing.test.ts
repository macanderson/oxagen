import { describe, expect, it } from "vitest";
import { requireScope } from "./index";
import { TEST_ORG, TEST_WS, TEST_SCOPE, withTestScope } from "./testing";

describe("test helpers", () => {
  it("runs a callback inside a deterministic test scope", () => {
    const seen = withTestScope(() => requireScope());
    // The active scope normalizes principal attribution to explicit nulls
    // (principal spine); the exported TEST_SCOPE constant remains tenant-only.
    expect(seen).toEqual({
      orgId: TEST_ORG,
      workspaceId: TEST_WS,
      principalId: null,
      principalKind: null,
      userId: null,
      capabilityName: null,
    });
    expect(TEST_SCOPE).toEqual({ orgId: TEST_ORG, workspaceId: TEST_WS });
  });

  it("TEST_SCOPE is frozen — one test must not repoint every other one", () => {
    expect(Object.isFrozen(TEST_SCOPE)).toBe(true);
    const handle = TEST_SCOPE as unknown as Record<string, unknown>;
    // This file is a module, so strict mode applies and the write throws
    // rather than silently no-opping.
    expect(() => {
      handle.orgId = "00000000-0000-0000-0000-0000000000ff";
    }).toThrow();
    expect(TEST_SCOPE.orgId).toBe(TEST_ORG);
  });

  it("accepts an override scope", () => {
    const org = "00000000-0000-0000-0000-0000000000d4";
    const seen = withTestScope(() => requireScope(), {
      orgId: org,
      workspaceId: TEST_WS,
    });
    expect(seen.orgId).toBe(org);
  });
});
