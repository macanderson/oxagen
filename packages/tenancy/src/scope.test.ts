import { describe, expect, it } from "vitest";
import {
  runInTenantScope,
  getScope,
  requireScope,
  TenantScopeError,
} from "./index";

const ORG = "00000000-0000-0000-0000-0000000000a1";
const WS = "00000000-0000-0000-0000-0000000000b2";
const ORG_B = "00000000-0000-0000-0000-0000000000c3";
const WS_B = "00000000-0000-0000-0000-0000000000d4";

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

  // ── Nested scope restores outer scope on exit ────────────────────────────

  it("nested runInTenantScope restores the outer scope after the inner callback returns", () => {
    let innerSeen: string | undefined;
    let afterInnerSeen: string | undefined;

    runInTenantScope({ orgId: ORG, workspaceId: WS }, () => {
      runInTenantScope({ orgId: ORG_B, workspaceId: WS_B }, () => {
        innerSeen = requireScope().orgId;
      });
      // After the nested scope exits, the outer scope must be restored.
      afterInnerSeen = requireScope().orgId;
    });

    expect(innerSeen).toBe(ORG_B);
    expect(afterInnerSeen).toBe(ORG);
    // After both scopes exit, getScope() is null again.
    expect(getScope()).toBeNull();
  });

  // ── Async callback still sees its scope after an await ───────────────────

  it("async callback sees its own scope after an internal await", async () => {
    const seenScopes: Array<{ orgId: string; workspaceId: string } | null> = [];

    await runInTenantScope({ orgId: ORG, workspaceId: WS }, async () => {
      seenScopes.push(getScope());
      // Yield to the event loop — simulates an async DB call.
      await Promise.resolve();
      seenScopes.push(getScope());
    });

    expect(seenScopes).toHaveLength(2);
    expect(seenScopes[0]).toEqual({ orgId: ORG, workspaceId: WS });
    expect(seenScopes[1]).toEqual({ orgId: ORG, workspaceId: WS });
  });

  // ── CONCURRENCY: parallel calls must not cross-leak ──────────────────────

  it("CONCURRENCY: two parallel runInTenantScope calls with different orgIds each see only their own scope", async () => {
    // This is the most critical cross-tenant safety test.
    // Two coroutines run concurrently with distinct (orgId, workspaceId) pairs.
    // Each must observe ONLY its own scope — never the other tenant's.

    const observedA: Array<string | undefined> = [];
    const observedB: Array<string | undefined> = [];

    const runA = runInTenantScope({ orgId: ORG, workspaceId: WS }, async () => {
      observedA.push(getScope()?.orgId);
      // Yield — allows B to run between checkpoints.
      await Promise.resolve();
      observedA.push(getScope()?.orgId);
      await Promise.resolve();
      observedA.push(getScope()?.orgId);
    });

    const runB = runInTenantScope({ orgId: ORG_B, workspaceId: WS_B }, async () => {
      observedB.push(getScope()?.orgId);
      await Promise.resolve();
      observedB.push(getScope()?.orgId);
      await Promise.resolve();
      observedB.push(getScope()?.orgId);
    });

    await Promise.all([runA, runB]);

    // Every checkpoint in A must have seen ORG, never ORG_B.
    expect(observedA).toHaveLength(3);
    for (const seen of observedA) {
      expect(seen).toBe(ORG);
    }

    // Every checkpoint in B must have seen ORG_B, never ORG.
    expect(observedB).toHaveLength(3);
    for (const seen of observedB) {
      expect(seen).toBe(ORG_B);
    }
  });
});
