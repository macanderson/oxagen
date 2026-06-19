import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, isNull, desc, sql } from "drizzle-orm";
import { recordSkillLoad } from "@oxagen/telemetry";
import type { CapabilityContext } from "../types";
import type { AgentSkillLoadInput, AgentSkillLoadOutput } from "@oxagen/oxagen/contracts/agent.skill.load";

export type { AgentSkillLoadInput, AgentSkillLoadOutput };

type VersionRow = { id: string; versionNumber: number; body: string };

/**
 * Match a version number against a constraint string.
 * Supported forms:
 *   - exact integer string: "3" → must equal 3
 *   - caret prefix "^N"    → must be >= N (same major compatibility)
 *   - tilde prefix "~N"    → must equal N (exact-major, latest patch in range)
 *   - omitted/empty        → any (active version, else latest)
 */
function matchesConstraint(versionNumber: number, constraint: string | undefined): boolean {
  if (!constraint) return true;
  if (constraint.startsWith("^")) {
    const min = parseInt(constraint.slice(1), 10);
    return !isNaN(min) && versionNumber >= min;
  }
  if (constraint.startsWith("~")) {
    const exact = parseInt(constraint.slice(1), 10);
    return !isNaN(exact) && versionNumber === exact;
  }
  const exact = parseInt(constraint, 10);
  return !isNaN(exact) && versionNumber === exact;
}

/** Extract capability slugs referenced in skill body (lines matching `## Capability: slug` or YAML-frontmatter `capabilities:` list). */
function parseCapabilities(body: string): string[] {
  const caps: string[] = [];
  for (const line of body.split("\n")) {
    const match = line.match(/^##\s+Capability:\s*(.+)$/i);
    if (match?.[1]) caps.push(match[1].trim());
    const yamlMatch = line.match(/^capabilities:\s*\[(.+)\]$/i);
    if (yamlMatch?.[1]) {
      caps.push(
        ...yamlMatch[1]
          .split(",")
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean),
      );
    }
  }
  return caps;
}

async function resolveSkillVersion(
  slug: string,
  version: string | undefined,
  orgId: string,
  workspaceId: string,
): Promise<{ skillId: string; row: VersionRow } | null> {
  const skill = await withTenantDb((tx) =>
    tx
      .select({ id: schema.skills.id, activeVersionId: schema.skills.activeVersionId })
      .from(schema.skills)
      .where(
        and(
          eq(schema.skills.orgId, orgId),
          eq(schema.skills.workspaceId, workspaceId),
          eq(schema.skills.slug, slug),
          eq(schema.skills.enabled, true),
          isNull(schema.skills.deletedAt),
        ),
      )
      .limit(1),
  );

  if (!skill[0]) return null;
  const skillId = skill[0].id;
  const activeVersionId = skill[0].activeVersionId;

  // Fetch all versions ordered descending so first match wins (latest first)
  const versions = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.skillVersions.id,
        versionNumber: schema.skillVersions.versionNumber,
        body: schema.skillVersions.body,
      })
      .from(schema.skillVersions)
      .where(eq(schema.skillVersions.skillId, skillId))
      .orderBy(desc(schema.skillVersions.versionNumber)),
  );

  // No explicit constraint: prefer the skill's explicitly-pinned active version
  // (decoupled from is_latest). Fall back to the latest version when no active
  // version is pinned or the pinned row is unavailable.
  if (!version && activeVersionId) {
    const active = versions.find((v) => v.id === activeVersionId);
    if (active) return { skillId, row: active };
  }

  const matched = versions.find((v) => matchesConstraint(v.versionNumber, version));
  if (!matched) return null;
  return { skillId, row: matched };
}

/**
 * Bump usage_count + last_used_at for a loaded skill. Best-effort: a failed
 * counter update must never fail the load itself.
 */
async function bumpSkillUsage(skillId: string): Promise<void> {
  try {
    await withTenantDb((tx) =>
      tx
        .update(schema.skills)
        .set({
          usageCount: sql`${schema.skills.usageCount} + 1`,
          lastUsedAt: new Date(),
        })
        .where(eq(schema.skills.id, skillId)),
    );
  } catch {
    // Swallow — usage analytics are non-critical to the load path.
  }
}

export async function agentSkillLoadHandler(
  input: AgentSkillLoadInput,
  ctx: CapabilityContext,
): Promise<AgentSkillLoadOutput> {
  const startedAt = Date.now();
  const dependencyErrors: AgentSkillLoadOutput["dependencyErrors"] = [];

  // Validate declared extra dependencies first (non-blocking; collect errors)
  const extra = input.dependencies ?? [];
  for (const depSlug of extra) {
    const resolved = await resolveSkillVersion(depSlug, undefined, ctx.orgId, ctx.workspaceId);
    if (!resolved) {
      dependencyErrors.push({ slug: depSlug, reason: `Skill '${depSlug}' not found or disabled in this workspace` });
    }
  }

  // Resolve the primary skill
  const resolved = await resolveSkillVersion(input.skillSlug, input.version, ctx.orgId, ctx.workspaceId);

  if (!resolved) {
    const versionHint = input.version ? ` (version constraint: ${input.version})` : "";
    return {
      skillSlug: input.skillSlug,
      loaded: false,
      versionLoaded: 0,
      body: "",
      capabilities: [],
      dependencyErrors: [
        ...dependencyErrors,
        {
          slug: input.skillSlug,
          reason: `Skill '${input.skillSlug}'${versionHint} not found, disabled, or version not available`,
        },
      ],
    };
  }

  const capabilities = parseCapabilities(resolved.row.body);

  // Telemetry + usage bookkeeping on a successful load. Both are best-effort
  // and must never fail or slow the load beyond their own budget.
  const loadLatencyMs = Date.now() - startedAt;
  await Promise.allSettled([
    recordSkillLoad({
      org_id: ctx.orgId,
      workspace_id: ctx.workspaceId,
      skill_id: resolved.skillId,
      skill_slug: input.skillSlug,
      skill_version: resolved.row.versionNumber,
      execution_step_id: null,
      surface: ctx.surface,
      load_latency_ms: loadLatencyMs,
      created_at: new Date().toISOString(),
    }),
    bumpSkillUsage(resolved.skillId),
  ]);

  return {
    skillSlug: input.skillSlug,
    loaded: true,
    versionLoaded: resolved.row.versionNumber,
    body: resolved.row.body,
    capabilities,
    dependencyErrors,
  };
}
