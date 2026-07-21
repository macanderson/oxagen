#!/usr/bin/env tsx
/**
 * seed-iam-defaults.ts — OXA-1389 Phase 2 (+ Agent RBAC Phase 1)
 *
 * Seeds `org.role_grants` rows for every system role in every org by walking
 * the exported capability contracts and reading each contract's `defaultRoles`
 * field. This is idempotent: all INSERTs use ON CONFLICT DO NOTHING.
 *
 * Also seeds the three SYSTEM default AGENT roles (docs/specs/agent-rbac/spec.md
 * §3.2) — "Agent Observer" / "Agent Contributor" / "Agent Operator" — as
 * `iam.roles` rows (one per org, scopeKind 'workspace', is_system_default=true)
 * with `iam.role_grants` derived from each contract's `agent.category` /
 * `agent.riskLevel` metadata, carrying a typed resourceScope ceiling in
 * `conditions_jsonb`. See the "Agent RBAC system roles" section below. That
 * phase is idempotent via ON CONFLICT ... DO UPDATE (re-running reconciles a
 * changed mapping in place, unlike the DO NOTHING phase above it).
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
import { parseResourceScope } from "@oxagen/oxagen/iam";
import { formatError } from "./lib/format-error";
import {
  AGENT_ROLE_SPECS,
  makeAgentRolePublicId,
  makeRoleGrantPublicId,
  selectAgentCapabilities,
  type AgentRoleName,
  type CapabilityLike,
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

/**
 * Seed the three system agent roles (one iam.roles row per org per role,
 * scope_kind='workspace', is_system_default=true) plus their role_grants,
 * derived from every capability's `agent.category` / `agent.riskLevel`.
 *
 * Idempotent via ON CONFLICT (public_id) DO UPDATE — unlike the human-role
 * phase's ON CONFLICT DO NOTHING, a re-run here reconciles an EFFECT or
 * resourceScope change in an already-seeded row rather than leaving it
 * stale, per the task's "re-running updates in place" requirement.
 */
async function seedAgentRoles(
  sql: ReturnType<typeof postgres>,
  capabilities: readonly CapabilityLike[],
): Promise<void> {
  // Validate every spec's resourceScope up front — a typo here should fail
  // the whole run loudly, not silently seed a payload that
  // parseResourceScope/evaluateConditions would later fail-closed on.
  for (const spec of AGENT_ROLE_SPECS) {
    if (parseResourceScope(spec.resourceScope) === null) {
      throw new Error(
        `[seed-iam] AGENT_ROLE_SPECS["${spec.name}"].resourceScope failed resourceScopeSchema validation`,
      );
    }
  }

  // Only capabilities that declare agent-surface metadata participate —
  // see the "Agent RBAC system roles" comment (tools/scripts/lib/seed-iam-defaults.ts) for why.
  const agentCapabilities = selectAgentCapabilities(capabilities);

  console.log(
    kleur.cyan(
      `[seed-iam] agent roles: ${agentCapabilities.length}/${capabilities.length} capabilities declare agent metadata`,
    ),
  );

  const orgs = await sql<{ id: string }[]>`
    SELECT id FROM org.organizations WHERE status != 'deleted'
  `;

  if (orgs.length === 0) {
    console.log(
      kleur.yellow(
        "[seed-iam] agent roles: no orgs found — nothing to seed (run pnpm db:migrate / create an org first)",
      ),
    );
    return;
  }

  if (agentCapabilities.length === 0) {
    console.log(
      kleur.yellow(
        "[seed-iam] agent roles: no capabilities declare agent metadata — roles will be created with zero grants",
      ),
    );
  }

  // ── (a) Upsert 3 roles × every org ────────────────────────────────────────
  interface RoleRow {
    id: string;
    public_id: string;
    org_id: string;
    scope_kind: "workspace";
    name: AgentRoleName;
    description: string;
    is_system_default: true;
  }

  const roleRows: RoleRow[] = [];
  for (const org of orgs) {
    for (const spec of AGENT_ROLE_SPECS) {
      roleRows.push({
        id: crypto.randomUUID(),
        public_id: makeAgentRolePublicId(org.id, "workspace", spec.name),
        org_id: org.id,
        scope_kind: "workspace",
        name: spec.name,
        description: spec.description,
        is_system_default: true,
      });
    }
  }

  // roleIdMap keyed by the deterministic public_id (NOT insertion order —
  // ON CONFLICT DO UPDATE ... RETURNING order isn't something to rely on).
  const roleIdMap = new Map<string, string>();
  const ROLE_CHUNK = 500;
  for (let i = 0; i < roleRows.length; i += ROLE_CHUNK) {
    const chunk = roleRows.slice(i, i + ROLE_CHUNK);
    const result = await sql<{ id: string; public_id: string }[]>`
      INSERT INTO iam.roles ${sql(
        chunk,
        "id",
        "public_id",
        "org_id",
        "scope_kind",
        "name",
        "description",
        "is_system_default",
      )}
      ON CONFLICT (public_id) DO UPDATE SET
        description = EXCLUDED.description,
        is_system_default = true,
        updated_at = now()
      RETURNING id, public_id
    `;
    for (const row of result) {
      roleIdMap.set(row.public_id, row.id);
    }
  }

  console.log(
    kleur.green(
      `[seed-iam] agent roles: ${roleIdMap.size} iam.roles rows upserted (${AGENT_ROLE_SPECS.length} roles × ${orgs.length} orgs)`,
    ),
  );

  // ── (b) Upsert role_grants for every (org, role, agent-capability) ────────
  interface AgentGrantRow {
    id: string;
    public_id: string;
    org_id: string;
    role_id: string;
    capability_id: string;
    effect: Effect;
    // Wrapped with sql.json() (not a pre-JSON.stringify'd plain string) so
    // postgres.js binds it with the jsonb OID (3802) explicitly — see
    // node_modules/postgres/src/index.js's `json()` helper. A plain string
    // parameter lets Postgres infer the column type from context, which
    // works for a simple single-row insert but is the wrong thing to rely
    // on here: this codebase's own convention for raw-`postgres` + jsonb
    // (apps/app/e2e/helpers/seed-code-repo.ts) is an explicit cast, and
    // sql.json() is the driver-native equivalent for the dynamic
    // multi-row `sql(chunk, ...columns)` insert helper, which offers no
    // way to splice a manual `::jsonb` cast per column.
    conditions_jsonb: ReturnType<typeof sql.json>;
  }

  const grantRows: AgentGrantRow[] = [];
  for (const org of orgs) {
    for (const spec of AGENT_ROLE_SPECS) {
      const rolePublicId = makeAgentRolePublicId(
        org.id,
        "workspace",
        spec.name,
      );
      const roleId = roleIdMap.get(rolePublicId);
      if (!roleId) {
        throw new Error(
          `[seed-iam] agent roles: role id not found for org ${org.id} / ${spec.name} after upsert`,
        );
      }
      // One Parameter instance reused across every capability row for this
      // (org, role) pair — sql.json() just wraps a value + OID, it isn't
      // mutated per-use, so reuse across rows/statements is safe.
      const conditionsJsonb = sql.json({ resourceScope: spec.resourceScope });

      for (const cap of agentCapabilities) {
        grantRows.push({
          id: crypto.randomUUID(),
          public_id: makeRoleGrantPublicId(roleId, cap.name),
          org_id: org.id,
          role_id: roleId,
          capability_id: cap.name,
          effect: spec.computeEffect(cap.category, cap.riskLevel),
          conditions_jsonb: conditionsJsonb,
        });
      }
    }
  }

  let upserted = 0;
  const GRANT_CHUNK = 500;
  for (let i = 0; i < grantRows.length; i += GRANT_CHUNK) {
    const chunk = grantRows.slice(i, i + GRANT_CHUNK);
    const result = await sql`
      INSERT INTO iam.role_grants ${sql(
        chunk,
        "id",
        "public_id",
        "org_id",
        "role_id",
        "capability_id",
        "effect",
        "conditions_jsonb",
      )}
      ON CONFLICT (public_id) DO UPDATE SET
        effect = EXCLUDED.effect,
        conditions_jsonb = EXCLUDED.conditions_jsonb,
        updated_at = now()
      RETURNING id
    `;
    upserted += result.length;
    console.log(
      kleur.dim(
        `[seed-iam] agent roles: ${Math.min(i + GRANT_CHUNK, grantRows.length)}/${grantRows.length} role_grant rows processed`,
      ),
    );
  }

  console.log(
    kleur.green(
      `[seed-iam] agent roles: ${upserted} role_grants upserted across ${orgs.length} orgs`,
    ),
  );
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

    // Build role_grants specs from each capability's defaultRoles declaration.
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

    // The two guards below used to `return` out of main() entirely. They now
    // fall through to the Agent RBAC phase (below) instead, because that
    // phase has its own independent data dependency (org.organizations, not
    // iam.roles) and shouldn't be skipped just because the human-role phase
    // found nothing to do.
    if (specs.length === 0) {
      console.log(
        kleur.yellow(
          "[seed-iam] no defaultRoles found — skipping human role_grants phase",
        ),
      );
    } else {
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
            "[seed-iam] no system roles found — skipping human role_grants phase (run pnpm db:migrate first)",
          ),
        );
      } else {
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
              `[seed-iam] ${Math.min(i + CHUNK, rows.length)}/${rows.length} rows processed`,
            ),
          );
        }
        const skipped = rows.length - inserted;

        console.log(
          kleur.green(
            `[seed-iam] role_grants: ${inserted} inserted, ${skipped} already existed`,
          ),
        );
      }
    }

    await seedAgentRoles(sql, capabilities);
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
