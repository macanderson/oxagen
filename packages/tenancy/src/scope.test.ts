import { describe, expect, it } from "vitest";
import {
  runInTenantScope,
  getScope,
  requireScope,
  TenantScopeError,
} from "./index";

const ORG = "00000000-0000-0000-0000-0000000000a1";
const WS = "00000000-0000-0000-0000-0000000000b2";

describe("tenant scope", () => {
  it("exposes the active scope inside runInTenantScope", () => {
    const seen = runInTenantScope({ orgId: ORG, workspaceId: WS }, () => getScope());
    expect(seen).toEqual({ orgId: ORG, workspaceId: WS });
  });

  it("returns null outside any scope", () => {
    expect(getScope()).toBeNull();
  });

  it("requireScope throws outside a scope (fail-closed)", () => {
    expect(() => requireScope()).toThrowError(TenantScopeError);
  });

  it("rejects an empty orgId (fixes MCP orgId:'' fail-open)", () => {
    expect(() => runInTenantScope({ orgId: "", workspaceId: WS }, () => 1)).toThrowError(
      /orgId/,
    );
  });

  it("rejects a non-uuid workspaceId", () => {
    expect(() =>
      runInTenantScope({ orgId: ORG, workspaceId: "not-a-uuid" }, () => 1),
    ).toThrowError(/workspaceId/);
  });

  it("isolates nested scopes and restores the outer one", () => {
    const other = "00000000-0000-0000-0000-0000000000c3";
    runInTenantScope({ orgId: ORG, workspaceId: WS }, () => {
      runInTenantScope({ orgId: other, workspaceId: WS }, () => {
        expect(requireScope().orgId).toBe(other);
      });
      expect(requireScope().orgId).toBe(ORG);
    });
  });
});
