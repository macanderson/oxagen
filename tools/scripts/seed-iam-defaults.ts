#!/usr/bin/env tsx
/**
 * seed-iam-defaults.ts — OXA-1389 Phase 2
 *
 * Seeds `org.role_grants` rows for every system role in every org by walking
 * the exported capability contracts and reading each contract's `defaultRoles`
 * field. This is idempotent: all INSERTs use ON CONFLICT DO NOTHING.
 *
 * Run via:
 *   pnpm db:seed-iam
 *
 * Requires a running Postgres reachable at DATABASE_URL (from .env.local or
 * doppler / vercel env pull).
 *
 * The script opens its own Postgres connection (not the Drizzle ORM) to keep
 * the dependency path simple and avoid circular imports at the script layer.
 * It dynamically imports `@oxagen/oxagen` so that the registry is populated
 * by the time `listCapabilities()` is called.
 */
import { createHash } from "node:crypto";
import postgres from "postgres";
import kleur from "kleur";
import { loadEnv } from "@oxagen/config/env";

// System role names seeded in 0008_iam_seed_defaults.sql.
const ORG_ROLES = ["Owner", "Admin", "Compliance", "Billing"] as const;
const WORKSPACE_ROLES = ["Owner", "Member", "Viewer"] as const;

type OrgRoleName = (typeof ORG_ROLES)[number];
type WorkspaceRoleName = (typeof WORKSPACE_ROLES)[number];
type Effect = "allow" | "deny" | "require_approval";

interface RoleGrantSpec {
  roleName: string;
  scopeKind: "org" | "workspace";
  capabilityId: string;
  effect: Effect;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false });

  try {
    // Dynamic import so the registry self-registers on first load.
    const { listCapabilities } = await import("@oxagen/oxagen");
    const capabilities = listCapabilities();

    console.log(kleur.cyan(`[seed-iam] found ${capabilities.length} capabilities`));

    // Build role_grants specs from each capability's defaultRoles declaration.
    const specs: RoleGrantSpec[] = [];

    for (const cap of capabilities) {
      if (!cap.defaultRoles) continue;

      const { org, workspace } = cap.defaultRoles;

      if (org) {
        for (const roleName of ORG_ROLES) {
          const effect = org[roleName as OrgRoleName];
          if (effect) {
            specs.push({ roleName, scopeKind: "org", capabilityId: cap.name, effect });
          }
        }
      }

      if (workspace) {
        for (const roleName of WORKSPACE_ROLES) {
          const effect = workspace[roleName as WorkspaceRoleName];
          if (effect) {
            specs.push({ roleName, scopeKind: "workspace", capabilityId: cap.name, effect });
          }
        }
      }
    }

    console.log(kleur.cyan(`[seed-iam] ${specs.length} role_grant specs derived from contracts`));

    if (specs.length === 0) {
      console.log(kleur.yellow("[seed-iam] no defaultRoles found — nothing to seed"));
      return;
    }

    // Fetch all existing system roles to obtain their UUIDs.
    const systemRoles = await sql<{ id: string; org_id: string; scope_kind: string; name: string }[]>`
      SELECT id, org_id, scope_kind, name
      FROM iam.roles
      WHERE is_system_default = 'true'
    `;

    if (systemRoles.length === 0) {
      console.log(
        kleur.yellow("[seed-iam] no system roles found — run pnpm db:migrate first"),
      );
      return;
    }

    // Generate a stable, collision-free public_id for a role_grant row.
    // Deterministic so re-runs are idempotent against the public_id UNIQUE
    // constraint. A previous version truncated the capability id to 14 chars,
    // which collided for capabilities sharing a prefix (e.g.
    // agent.task.background.{start,read,cancel}) and silently dropped grants.
    function makePublicId(roleId: string, capabilityId: string): string {
      const digest = createHash("sha256")
        .update(`${roleId}:${capabilityId}`)
        .digest("hex")
        .slice(0, 24);
      return `rlg_${digest}`;
    }

    let inserted = 0;
    let skipped = 0;

    for (const spec of specs) {
      // Find all system roles matching (scope_kind, name) across all orgs.
      const matchingRoles = systemRoles.filter(
        (r) => r.scope_kind === spec.scopeKind && r.name === spec.roleName,
      );

      for (const role of matchingRoles) {
        const publicId = makePublicId(role.id, spec.capabilityId);

        const result = await sql`
          INSERT INTO iam.role_grants (id, public_id, org_id, role_id, capability_id, effect)
          VALUES (
            gen_random_uuid(),
            ${publicId},
            ${role.org_id},
            ${role.id},
            ${spec.capabilityId},
            ${spec.effect}
          )
          ON CONFLICT DO NOTHING
          RETURNING id
        `;

        if (result.length > 0) {
          inserted++;
        } else {
          skipped++;
        }
      }
    }

    console.log(
      kleur.green(
        `[seed-iam] role_grants: ${inserted} inserted, ${skipped} already existed`,
      ),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(kleur.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
