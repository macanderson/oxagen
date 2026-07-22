#!/usr/bin/env tsx
/**
 * seed-iam-defaults.ts — OXA-1389 Phase 2 + Agent RBAC Phase 1
 *
 * Two independent seed phases against the SAME capability registry:
 *
 *   Phase 2 (legacy):  seeds `iam.role_grants` for the 7 pre-existing system
 *     roles (org: Owner/Admin/Compliance/Billing, workspace: Owner/Member/
 *     Viewer) by walking each capability contract's `defaultRoles` field.
 *
 *   Agent RBAC Phase 1 (docs/specs/agent-rbac/spec.md §3.2): seeds exactly
 *     THREE system workspace roles for agent principals —
 *       "Agent Observer"    — read/answer only
 *       "Agent Contributor" — standard worker
 *       "Agent Operator"    — trusted automation
 *     No unrestricted/legacy fourth role exists — pre-launch, there is no
 *     backwards-compatibility path to preserve (§6, open question 1). Any
 *     "Agent Legacy*" role found in iam.roles (from an earlier draft/manual
 *     edit) is actively deleted, along with its role_grants, rather than
 *     left to coexist with the three canonical roles.
 *     Grant effects are derived from each capability's `agent.category` /
 *     `agent.riskLevel` metadata (packages/oxagen/src/contracts/*.ts), and
 *     every grant row carries a `resourceScope` condition (a CEILING, not an
 *     allow/deny gate — see packages/oxagen/src/iam/conditions.ts) so the
 *     resolver can intersect it against the agent definition's own
 *     graphAccess/agentTools declaration. This script only SEEDS the data;
 *     enforcement lives in the resolver (a separate change).
 *
 * Both phases are idempotent:
 *   - role_grants (legacy phase): INSERT ... ON CONFLICT DO NOTHING.
 *   - iam.roles (agent phase): INSERT ... ON CONFLICT (public_id) DO UPDATE
 *     so re-running updates an existing role's description/flags in place.
 *   - iam.role_grants (agent phase): bulk chunked INSERT ... SELECT ...
 *     FROM (VALUES ...) ... ON CONFLICT (public_id) DO UPDATE, mirroring the
 *     legacy phase's chunking, so a capability's effect/resourceScope
 *     changing on re-run is reflected, not silently skipped.
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
import postgres from "postgres";
import kleur from "kleur";
import { loadEnv } from "@oxagen/config/env";
import { formatError } from "./lib/format-error";
import {
  AGENT_ROLE_DESCRIPTIONS,
  AGENT_ROLE_NAMES,
  AGENT_ROLE_RESOURCE_SCOPE,
  LEGACY_ROLE_NAME_ILIKE_PATTERN,
  agentRoleEffect,
  makeRoleGrantPublicId,
  makeRolePublicId,
  type AgentRoleName,
  type Effect,
} from "./lib/seed-iam-defaults";

// System role names seeded in 0008_iam_seed_defaults.sql.
const ORG_ROLES = ["Owner", "Admin", "Compliance", "Billing"] as const;
const WORKSPACE_ROLES = ["Owner", "Member", "Viewer"] as const;

type OrgRoleName = (typeof ORG_ROLES)[number];
type WorkspaceRoleName = (typeof WORKSPACE_ROLES)[number];

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

    console.log(
      kleur.cyan(`[seed-iam] found ${capabilities.length} capabilities`),
    );

    // ── Phase 2 (legacy): role_grants from each contract's defaultRoles ─────
    const specs: RoleGrantSpec[] = [];

    for (const cap of capabilities) {
      if (!cap.defaultRoles) continue;

      const { org, workspace } = cap.defaultRoles;

      if (org) {
        for (const roleName of ORG_ROLES) {
          const effect = org[roleName as OrgRoleName];
          if (effect) {
            specs.push({
              roleName,
              scopeKind: "org",
              capabilityId: cap.name,
              effect,
            });
          }
        }
      }

      if (workspace) {
        for (const roleName of WORKSPACE_ROLES) {
          const effect = workspace[roleName as WorkspaceRoleName];
          if (effect) {
            specs.push({
              roleName,
              scopeKind: "workspace",
              capabilityId: cap.name,
              effect,
            });
          }
        }
      }
    }

    console.log(
      kleur.cyan(
        `[seed-iam] ${specs.length} role_grant specs derived from contracts`,
      ),
    );

    // Fetch all existing system roles to obtain their UUIDs.
    const systemRoles = await sql<
      { id: string; org_id: string; scope_kind: string; name: string }[]
    >`
      SELECT id, org_id, scope_kind, name
      FROM iam.roles
      WHERE is_system_default = 'true'
    `;

    if (systemRoles.length === 0) {
      console.log(
        kleur.yellow(
          "[seed-iam] no system roles found — run pnpm db:migrate first",
        ),
      );
      return;
    }

    if (specs.length > 0) {
      // Materialize every row client-side, then bulk-insert in chunks. The
      // previous one-INSERT-per-row loop meant ~specs × orgs sequential
      // round-trips (~30k against prod over a WAN — an hour-plus); chunked
      // multi-row inserts finish in seconds. ON CONFLICT DO NOTHING also
      // resolves duplicates arising within a single statement, so re-runs and
      // intra-chunk collisions stay idempotent.
      interface GrantRow {
        id: string;
        public_id: string;
        org_id: string;
        role_id: string;
        capability_id: string;
        effect: Effect;
      }

      const rows: GrantRow[] = [];
      for (const spec of specs) {
        // Find all system roles matching (scope_kind, name) across all orgs.
        const matchingRoles = systemRoles.filter(
          (r) => r.scope_kind === spec.scopeKind && r.name === spec.roleName,
        );

        for (const role of matchingRoles) {
          rows.push({
            id: crypto.randomUUID(),
            public_id: makeRoleGrantPublicId(role.id, spec.capabilityId),
            org_id: role.org_id,
            role_id: role.id,
            capability_id: spec.capabilityId,
            effect: spec.effect,
          });
        }
      }

      let inserted = 0;
      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const result = await sql`
          INSERT INTO iam.role_grants ${sql(chunk, "id", "public_id", "org_id", "role_id", "capability_id", "effect")}
          ON CONFLICT DO NOTHING
          RETURNING id
        `;
        inserted += result.length;
        console.log(
          kleur.dim(
            `[seed-iam] ${Math.min(i + CHUNK, rows.length)}/${rows.length} legacy rows processed`,
          ),
        );
      }
      const skipped = rows.length - inserted;

      console.log(
        kleur.green(
          `[seed-iam] legacy role_grants: ${inserted} inserted, ${skipped} already existed`,
        ),
      );
    } else {
      console.log(
        kleur.yellow(
          "[seed-iam] no legacy defaultRoles found — nothing to seed there",
        ),
      );
    }

    // ── Agent RBAC Phase 1: remove any stray "Agent Legacy" role ────────────
    // No fourth "Agent Legacy (unrestricted)" role is ever created by this
    // script (§6 open question 1: pre-launch, reset instead of migrate — no
    // backwards-compatibility path). This is a defensive migration step: if
    // an earlier draft of this script, a manual DB edit, or a hand-rolled
    // fixture ever created one, remove it (and its role_grants) rather than
    // silently coexisting with the three canonical roles. Matches on the
    // workspace-scoped, system-default name the superseded spec draft used
    // ("Agent Legacy" / "Agent Legacy (unrestricted)") — a prefix match
    // covers both spellings without touching any *other* system role.
    const legacyRoles = await sql<
      { id: string; org_id: string; name: string }[]
    >`
      SELECT id, org_id, name
      FROM iam.roles
      WHERE is_system_default = 'true'
        AND scope_kind = 'workspace'
        AND name ILIKE ${LEGACY_ROLE_NAME_ILIKE_PATTERN}
    `;

    if (legacyRoles.length > 0) {
      const legacyRoleIds = legacyRoles.map((r) => r.id);
      const deletedGrants = await sql`
        DELETE FROM iam.role_grants
        WHERE role_id = ANY(${legacyRoleIds})
        RETURNING id
      `;
      const deletedRoles = await sql`
        DELETE FROM iam.roles
        WHERE id = ANY(${legacyRoleIds})
        RETURNING id
      `;
      console.log(
        kleur.yellow(
          `[seed-iam] removed ${deletedRoles.length} legacy "Agent Legacy*" role(s) and ` +
            `${deletedGrants.length} associated role_grant(s) — no back-compat/unrestricted ` +
            `agent role is supported (§6 open question 1)`,
        ),
      );
    }

    // ── Agent RBAC Phase 1: three system workspace roles + role_grants ─────
    // One row per org per role name, distinct from the legacy workspace
    // Owner/Member/Viewer roles fetched above.
    const orgIds = Array.from(new Set(systemRoles.map((r) => r.org_id)));

    console.log(
      kleur.cyan(
        `[seed-iam] seeding ${AGENT_ROLE_NAMES.length} agent system role(s) across ${orgIds.length} org(s)`,
      ),
    );

    // agentCapabilities: only capabilities with agent-surface metadata are
    // relevant to agent-role grants — an agent role has no opinion on a
    // capability the agent surface never exposes.
    const agentCapabilities = capabilities.filter(
      (cap) => cap.agent !== undefined,
    );

    let agentRolesUpserted = 0;
    let agentGrantsUpserted = 0;

    for (const orgId of orgIds) {
      // roleId per (org, agent role name).
      const agentRoleIdByName = new Map<AgentRoleName, string>();

      for (const roleName of AGENT_ROLE_NAMES) {
        const publicId = makeRolePublicId(orgId, "workspace", roleName);
        const [row] = await sql<{ id: string }[]>`
          INSERT INTO iam.roles (public_id, org_id, scope_kind, name, description, is_system_default)
          VALUES (${publicId}, ${orgId}, 'workspace', ${roleName}, ${AGENT_ROLE_DESCRIPTIONS[roleName]}, true)
          ON CONFLICT (public_id) DO UPDATE
            SET description = EXCLUDED.description,
                is_system_default = true,
                scope_kind = EXCLUDED.scope_kind,
                updated_at = now()
          RETURNING id
        `;
        if (!row) {
          throw new Error(
            `[seed-iam] failed to upsert agent role "${roleName}" for org ${orgId}`,
          );
        }
        agentRoleIdByName.set(roleName, row.id);
        agentRolesUpserted += 1;
      }

      // role_grants: one row per (agent role, agent-surfaced capability),
      // carrying the role's resourceScope ceiling as a conditions_jsonb
      // condition (packages/oxagen/src/iam/conditions.ts). Seed data only —
      // the resolver's role-grant resourceScope read path is a separate
      // change.
      //
      // Materialize every row client-side, then bulk-upsert in chunks —
      // the same fix already applied to the legacy phase above. The
      // previous version issued one INSERT per (role, capability) pair
      // (~3 roles × ~337 agent-surfaced capabilities = ~1,011 sequential
      // round-trips per org), which is minutes against a WAN-latency
      // Postgres for a multi-org seed. Chunked multi-row upserts cut that
      // to a handful of round-trips per org while preserving the exact
      // same ON CONFLICT (public_id) DO UPDATE semantics per row.
      interface AgentGrantRow {
        public_id: string;
        org_id: string;
        role_id: string;
        capability_id: string;
        effect: Effect;
        conditions_jsonb: string;
      }

      const agentGrantRows: AgentGrantRow[] = [];
      for (const roleName of AGENT_ROLE_NAMES) {
        const roleId = agentRoleIdByName.get(roleName);
        if (!roleId) continue;
        const resourceScope = AGENT_ROLE_RESOURCE_SCOPE[roleName];
        const conditionsJsonb = JSON.stringify({ resourceScope });

        for (const cap of agentCapabilities) {
          const effect = agentRoleEffect(
            roleName,
            cap.agent?.category,
            cap.agent?.riskLevel,
            cap.agent?.requiresApproval,
          );
          agentGrantRows.push({
            public_id: makeRoleGrantPublicId(roleId, cap.name),
            org_id: orgId,
            role_id: roleId,
            capability_id: cap.name,
            effect,
            conditions_jsonb: conditionsJsonb,
          });
        }
      }

      const AGENT_GRANT_CHUNK = 500;
      for (let i = 0; i < agentGrantRows.length; i += AGENT_GRANT_CHUNK) {
        const chunk = agentGrantRows.slice(i, i + AGENT_GRANT_CHUNK);
        await sql`
          INSERT INTO iam.role_grants
            (public_id, org_id, role_id, capability_id, effect, conditions_jsonb)
          SELECT public_id, org_id, role_id, capability_id, effect, conditions_jsonb::jsonb
          FROM ${sql(chunk, "public_id", "org_id", "role_id", "capability_id", "effect", "conditions_jsonb")}
          ON CONFLICT (public_id) DO UPDATE
            SET effect = EXCLUDED.effect,
                conditions_jsonb = EXCLUDED.conditions_jsonb,
                updated_at = now()
        `;
        agentGrantsUpserted += chunk.length;
      }
    }

    console.log(
      kleur.green(
        `[seed-iam] agent roles upserted: ${agentRolesUpserted}; agent role_grants upserted: ${agentGrantsUpserted}`,
      ),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(kleur.red(formatError(err)));
    process.exit(1);
  });
