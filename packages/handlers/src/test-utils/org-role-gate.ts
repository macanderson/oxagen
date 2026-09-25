// A double for `@oxagen/iam/org-role` that keeps the real role gate.
//
// `assertOrgRole` runs for real, against the `role-tx.ts` transaction double,
// so a handler test states the caller's roles and nothing else. The test's own
// database double is left alone: the gate reads through the transaction this
// module hands it, never through `withOrgDb`. A test wires it with
//
//   vi.mock("@oxagen/iam/org-role", async () =>
//     (await import("./test-utils/org-role-gate")).orgRoleModule(),
//   );
//
// and sets `roleGate.roles` in `beforeEach` or in a case. The default is an
// org Owner, so a suite written before its handler gained a role gate keeps
// passing unchanged.
import type { Tx } from "@oxagen/database";
import { vi } from "vitest";
import { type RoleFixture, roleTx } from "./role-tx";

const OWNER: RoleFixture = { org: "Owner" };

/** The caller's roles for the next call; reset with `resetRoleGate`. */
export const roleGate: { roles: RoleFixture } = { roles: OWNER };

/** Back to an org Owner. */
export function resetRoleGate(): void {
  roleGate.roles = OWNER;
}

/** The signed-in user, or the API key's creator the fixture names. */
async function actingUser(ctx: {
  userId: string | null;
  apiKeyId: string | null;
}): Promise<string | null> {
  if (ctx.userId) return ctx.userId;
  return ctx.apiKeyId ? (roleGate.roles.keyCreator ?? null) : null;
}

/** The module the mock factory returns. */
export async function orgRoleModule() {
  const real = await vi.importActual<typeof import("@oxagen/iam/org-role")>(
    "@oxagen/iam/org-role",
  );
  return {
    ...real,
    resolveActingUserId: actingUser,
    assertOrgRole: (
      ctx: Parameters<typeof real.assertOrgRole>[0],
      required: Parameters<typeof real.assertOrgRole>[1],
    ) =>
      real.assertOrgRole(
        ctx,
        required,
        roleTx(roleGate.roles) as unknown as Tx,
      ),
  };
}
