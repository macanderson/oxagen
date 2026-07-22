import { describe, it, expect } from "vitest";
import {
  resolveAssignerEffectiveGrants,
  targetRoleExceedsAssignerGrants,
} from "./_agent-role";

// Minimal fake Tx: a queue of query results consumed in call order. Mirrors
// the sequential-mock pattern used by org.member_role.change.test.ts.
function makeFakeTx(resultQueue: unknown[][]) {
  let i = 0;
  const next = () => resultQueue[i++] ?? [];
  const tx = {
    select: () => {
      const builder = {
        from: () => builder,
        innerJoin: () => builder,
        where: () => {
          const result = next();
          return Object.assign(Promise.resolve(result), {
            limit: () => Promise.resolve(result),
          });
        },
      };
      return builder;
    },
  };
  return tx as unknown as import("@oxagen/database").Tx;
}

describe("resolveAssignerEffectiveGrants", () => {
  it("returns isOwner=true when the assigner holds the system Owner role", async () => {
    const tx = makeFakeTx([
      [{ id: "principal-1" }], // human principal lookup
      [{ roleId: "role-owner", roleName: "Owner", isSystemDefault: true }], // role rows
    ]);
    const grants = await resolveAssignerEffectiveGrants(tx, "org-1", "user-1");
    expect(grants.isOwner).toBe(true);
  });

  it("returns empty grants when the human has no principal", async () => {
    const tx = makeFakeTx([[]]);
    const grants = await resolveAssignerEffectiveGrants(tx, "org-1", "user-1");
    expect(grants.isOwner).toBe(false);
    expect(grants.byCapability.size).toBe(0);
  });

  it("collects the strongest effect per capability across roles", async () => {
    const tx2 = makeFakeTx([
      [{ id: "principal-1" }],
      [{ roleId: "role-a", roleName: "Custom A", isSystemDefault: false }],
      [
        { capabilityId: "cap.read", effect: "allow" },
        { capabilityId: "cap.write", effect: "deny" },
      ],
    ]);
    const grants = await resolveAssignerEffectiveGrants(tx2, "org-1", "user-1");
    expect(grants.isOwner).toBe(false);
    expect(grants.byCapability.get("cap.read")).toBe("allow");
    expect(grants.byCapability.get("cap.write")).toBe("deny");
  });
});

describe("targetRoleExceedsAssignerGrants", () => {
  it("never exceeds for an Owner assigner", async () => {
    const tx = makeFakeTx([
      [{ capabilityId: "cap.anything", effect: "allow" }],
    ]);
    const result = await targetRoleExceedsAssignerGrants(tx, "role-target", {
      isOwner: true,
      byCapability: new Map(),
    });
    expect(result.exceeds).toBe(false);
  });

  it("exceeds when the target role allows a capability the assigner doesn't", async () => {
    const tx = makeFakeTx([[{ capabilityId: "cap.secret", effect: "allow" }]]);
    const result = await targetRoleExceedsAssignerGrants(tx, "role-target", {
      isOwner: false,
      byCapability: new Map(),
    });
    expect(result.exceeds).toBe(true);
    expect(result.capability).toBe("cap.secret");
  });

  it("does not exceed when the assigner already allows every capability the target role allows", async () => {
    const tx = makeFakeTx([[{ capabilityId: "cap.read", effect: "allow" }]]);
    const result = await targetRoleExceedsAssignerGrants(tx, "role-target", {
      isOwner: false,
      byCapability: new Map([["cap.read", "allow"]]),
    });
    expect(result.exceeds).toBe(false);
  });

  it("ignores non-allow target grants (deny/require_approval never extend power)", async () => {
    const tx = makeFakeTx([
      [{ capabilityId: "cap.risky", effect: "require_approval" }],
    ]);
    const result = await targetRoleExceedsAssignerGrants(tx, "role-target", {
      isOwner: false,
      byCapability: new Map(),
    });
    expect(result.exceeds).toBe(false);
  });
});
