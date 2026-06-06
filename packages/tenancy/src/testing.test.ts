import { describe, expect, it } from "vitest";
import { requireScope } from "./index";
import { TEST_ORG, TEST_WS, TEST_SCOPE, withTestScope } from "./testing";

describe("test helpers", () => {
  it("runs a callback inside a deterministic test scope", () => {
    const seen = withTestScope(() => requireScope());
    expect(seen).toEqual({ orgId: TEST_ORG, workspaceId: TEST_WS });
    expect(TEST_SCOPE).toEqual({ orgId: TEST_ORG, workspaceId: TEST_WS });
  });

  it("accepts an override scope", () => {
    const org = "00000000-0000-0000-0000-0000000000d4";
    const seen = withTestScope(() => requireScope(), { orgId: org, workspaceId: TEST_WS });
    expect(seen.orgId).toBe(org);
  });
});
