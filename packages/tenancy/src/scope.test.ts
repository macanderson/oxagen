import { describe, expect, it } from "vitest";
import {
  runInTenantScope,
  runWithPrincipal,
  getScope,
  requireScope,
  getPrincipalAttribution,
  TenantScopeError,
} from "./index";

const ORG = "00000000-0000-0000-0000-0000000000a1";
const WS = "00000000-0000-0000-0000-0000000000b2";
const ORG_B = "00000000-0000-0000-0000-0000000000c3";
const WS_B = "00000000-0000-0000-0000-0000000000d4";
const PRINCIPAL = "00000000-0000-0000-0000-0000000000e5";
const USER = "00000000-0000-0000-0000-0000000000f6";

/** All-null attribution — the shape every unattributed scope carries. */
const NO_ATTRIBUTION = {
  principalId: null,
  principalKind: null,
  userId: null,
  capabilityName: null,
} as const;

describe("tenant scope", () => {
  it("exposes the active scope inside runInTenantScope", () => {
    const seen = runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      getScope(),
    );
    expect(seen).toEqual({ orgId: ORG, workspaceId: WS, ...NO_ATTRIBUTION });
  });

  it("returns null outside any scope", () => {
    expect(getScope()).toBeNull();
  });

  it("requireScope throws outside a scope (fail-closed)", () => {
    expect(() => requireScope()).toThrowError(TenantScopeError);
  });

  it("rejects an empty orgId", () => {
    expect(() =>
      runInTenantScope({ orgId: "", workspaceId: WS }, () => 1),
    ).toThrowError(/orgId/);
  });

  it("rejects a non-uuid workspaceId", () => {
    expect(() =>
      runInTenantScope({ orgId: ORG, workspaceId: "not-a-uuid" }, () => 1),
    ).toThrowError(/workspaceId/);
  });

  it("truncates a long rejected id instead of echoing it whole into the log", () => {
    const huge = "x".repeat(5000);
    let message = "";
    try {
      runInTenantScope({ orgId: huge, workspaceId: WS }, () => 1);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/orgId/);
    expect(message).toContain("(5000 chars)");
    expect(message.length).toBeLessThan(200);
  });

  it("rejects a non-string id as a TenantScopeError, not a TypeError", () => {
    // The `string` type is a compile-time promise; untyped callers (Inngest
    // step payloads, JS interop) can still hand this undefined.
    expect(() =>
      runInTenantScope(
        { orgId: undefined as unknown as string, workspaceId: WS },
        () => 1,
      ),
    ).toThrowError(TenantScopeError);
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

  // ── The stored snapshot is frozen (readonly is erased at runtime) ────────

  it("the active scope cannot be mutated through the handle it hands out", () => {
    runInTenantScope({ orgId: ORG, workspaceId: WS }, () => {
      const handle = requireScope() as unknown as Record<string, unknown>;
      expect(Object.isFrozen(handle)).toBe(true);
      // Non-strict assignment would silently no-op; this file is a module, so
      // strict mode applies and the write throws. Either way the scope holds.
      expect(() => {
        handle.orgId = ORG_B;
      }).toThrow();
      expect(requireScope().orgId).toBe(ORG);
    });
  });

  it("getPrincipalAttribution's out-of-scope result is frozen", () => {
    expect(Object.isFrozen(getPrincipalAttribution())).toBe(true);
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
    expect(seenScopes[0]).toEqual({
      orgId: ORG,
      workspaceId: WS,
      ...NO_ATTRIBUTION,
    });
    expect(seenScopes[1]).toEqual({
      orgId: ORG,
      workspaceId: WS,
      ...NO_ATTRIBUTION,
    });
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

    const runB = runInTenantScope(
      { orgId: ORG_B, workspaceId: WS_B },
      async () => {
        observedB.push(getScope()?.orgId);
        await Promise.resolve();
        observedB.push(getScope()?.orgId);
        await Promise.resolve();
        observedB.push(getScope()?.orgId);
      },
    );

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

  // ── Principal attribution (accountability-chain spine) ────────────────────

  describe("principal attribution", () => {
    it("carries attribution fields through the scope", () => {
      const attribution = runInTenantScope(
        {
          orgId: ORG,
          workspaceId: WS,
          principalId: PRINCIPAL,
          principalKind: "agent",
          userId: USER,
          capabilityName: "query_ontology",
        },
        () => getPrincipalAttribution(),
      );
      expect(attribution).toEqual({
        principalId: PRINCIPAL,
        principalKind: "agent",
        userId: USER,
        capabilityName: "query_ontology",
      });
    });

    it("getPrincipalAttribution never throws — all-null outside a scope", () => {
      expect(getPrincipalAttribution()).toEqual(NO_ATTRIBUTION);
    });

    it("getPrincipalAttribution is all-null inside an unattributed scope", () => {
      const attribution = runInTenantScope(
        { orgId: ORG, workspaceId: WS },
        () => getPrincipalAttribution(),
      );
      expect(attribution).toEqual(NO_ATTRIBUTION);
    });

    it("rejects a non-uuid principalId (fail-closed on garbage attribution)", () => {
      expect(() =>
        runInTenantScope(
          { orgId: ORG, workspaceId: WS, principalId: "agent-1" },
          () => 1,
        ),
      ).toThrowError(/principalId/);
    });

    it("rejects a non-uuid userId", () => {
      expect(() =>
        runInTenantScope(
          { orgId: ORG, workspaceId: WS, userId: "mac" },
          () => 1,
        ),
      ).toThrowError(/userId/);
    });

    it("rejects an unknown principalKind", () => {
      expect(() =>
        runInTenantScope(
          {
            orgId: ORG,
            workspaceId: WS,
            principalKind: "robot" as unknown as "agent",
          },
          () => 1,
        ),
      ).toThrowError(/principalKind/);
    });

    it("runWithPrincipal enriches the active scope without changing tenant ids", () => {
      runInTenantScope(
        { orgId: ORG, workspaceId: WS, userId: USER, capabilityName: "x.y" },
        () => {
          runWithPrincipal(
            { principalId: PRINCIPAL, principalKind: "human" },
            () => {
              expect(requireScope()).toEqual({
                orgId: ORG,
                workspaceId: WS,
                principalId: PRINCIPAL,
                principalKind: "human",
                userId: USER,
                capabilityName: "x.y",
              });
            },
          );
          // Enrichment is a nested snapshot — the outer scope is untouched.
          expect(requireScope().principalId).toBeNull();
        },
      );
    });

    it("runWithPrincipal ignores undefined keys instead of erasing attribution", () => {
      // `{ principalId: maybeResolved?.id }` yields `undefined` when the
      // optional chain misses. A plain spread would overwrite the scope's
      // existing userId/capabilityName with undefined → null.
      runInTenantScope(
        { orgId: ORG, workspaceId: WS, userId: USER, capabilityName: "x.y" },
        () => {
          runWithPrincipal(
            { principalId: undefined, userId: undefined },
            () => {
              const seen = getPrincipalAttribution();
              expect(seen.userId).toBe(USER);
              expect(seen.capabilityName).toBe("x.y");
            },
          );
        },
      );
    });

    it("runWithPrincipal cannot switch tenant through a smuggled orgId", () => {
      // Excess-property checking only fires on fresh literals, so a wider
      // variable can carry an orgId. Enriching who-acted must never move
      // which-tenant.
      const smuggled = {
        principalId: PRINCIPAL,
        orgId: ORG_B,
        workspaceId: WS_B,
      } as Partial<{ principalId: string }>;
      runInTenantScope({ orgId: ORG, workspaceId: WS }, () => {
        runWithPrincipal(smuggled, () => {
          expect(requireScope().orgId).toBe(ORG);
          expect(requireScope().workspaceId).toBe(WS);
          expect(requireScope().principalId).toBe(PRINCIPAL);
        });
      });
    });

    it("runWithPrincipal still clears a field on an explicit null", () => {
      runInTenantScope({ orgId: ORG, workspaceId: WS, userId: USER }, () => {
        runWithPrincipal({ userId: null }, () => {
          expect(getPrincipalAttribution().userId).toBeNull();
        });
      });
    });

    it("runWithPrincipal is a passthrough when no scope is active", () => {
      const out = runWithPrincipal({ principalId: PRINCIPAL }, () => {
        expect(getScope()).toBeNull();
        return 42;
      });
      expect(out).toBe(42);
    });

    it("runWithPrincipal validates the enriched attribution fail-closed", () => {
      runInTenantScope({ orgId: ORG, workspaceId: WS }, () => {
        expect(() =>
          runWithPrincipal({ principalId: "not-a-uuid" }, () => 1),
        ).toThrowError(/principalId/);
      });
    });

    it("async attribution does not cross-leak between parallel scopes", async () => {
      const seenA: Array<string | null> = [];
      const seenB: Array<string | null> = [];
      const runA = runInTenantScope(
        { orgId: ORG, workspaceId: WS, principalId: PRINCIPAL },
        async () => {
          seenA.push(getPrincipalAttribution().principalId);
          await Promise.resolve();
          seenA.push(getPrincipalAttribution().principalId);
        },
      );
      const runB = runInTenantScope(
        { orgId: ORG_B, workspaceId: WS_B },
        async () => {
          seenB.push(getPrincipalAttribution().principalId);
          await Promise.resolve();
          seenB.push(getPrincipalAttribution().principalId);
        },
      );
      await Promise.all([runA, runB]);
      expect(seenA).toEqual([PRINCIPAL, PRINCIPAL]);
      expect(seenB).toEqual([null, null]);
    });
  });
});
