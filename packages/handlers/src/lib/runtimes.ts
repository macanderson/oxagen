// runtimes.ts — runtimes and agent versions (ADR-192): resolving a runtime,
// the one-live-agent-per-runtime-and-harness rule, the runtime a host
// enrollment binds, and the version an agent writes when its runtime or
// toolbelt changes.
//
// A unique violation aborts the transaction it happens in, so every rule
// here is checked with a read first and the index is the backstop for a
// race. The handler maps a backstop violation to the same conflict.
import { schema, type Tx } from "@oxagen/database";
import { HandlerError } from "@oxagen/oxagen";
import {
  RUNTIME_SLUG_MAX,
  slugFromName,
} from "@oxagen/oxagen/contracts/runtime.shared";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";

type Scope = { orgId: string; workspaceId: string };

export interface RuntimeRow {
  id: string;
  publicId: string;
  name: string;
  slug: string;
}

const runtimeColumns = {
  id: schema.runtimes.id,
  publicId: schema.runtimes.publicId,
  name: schema.runtimes.name,
  slug: schema.runtimes.slug,
} as const;

/** The runtime as a contract reference. */
export function runtimeRefOf(row: RuntimeRow): {
  id: string;
  name: string;
  slug: string;
} {
  return { id: row.publicId, name: row.name, slug: row.slug };
}

/** A live runtime by public id in the caller's workspace, or `not_found`. */
export async function requireRuntime(
  tx: Tx,
  scope: Scope,
  publicId: string,
): Promise<RuntimeRow> {
  const [row] = await tx
    .select(runtimeColumns)
    .from(schema.runtimes)
    .where(
      and(
        eq(schema.runtimes.orgId, scope.orgId),
        eq(schema.runtimes.workspaceId, scope.workspaceId),
        eq(schema.runtimes.publicId, publicId),
        isNull(schema.runtimes.deletedAt),
      ),
    )
    .limit(1);
  if (!row) {
    throw new HandlerError({
      code: "not_found",
      reason: "runtime_not_found",
      message: `No runtime "${publicId}" in this workspace`,
    });
  }
  return row;
}

/** Whether a live runtime in the workspace holds this slug. */
export async function runtimeSlugTaken(
  tx: Tx,
  scope: Scope,
  slug: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: schema.runtimes.id })
    .from(schema.runtimes)
    .where(
      and(
        eq(schema.runtimes.orgId, scope.orgId),
        eq(schema.runtimes.workspaceId, scope.workspaceId),
        eq(schema.runtimes.slug, slug),
        isNull(schema.runtimes.deletedAt),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** The refusal for a slug another live runtime holds. */
export function runtimeSlugTakenError(slug: string): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "runtime_slug_taken",
    message: `Another runtime in this workspace uses the slug "${slug}". Choose another slug.`,
  });
}

/** Insert one runtime. The caller has checked the slug is free. */
export async function insertRuntime(
  tx: Tx,
  scope: Scope,
  args: { name: string; slug: string; userId: string | null },
): Promise<RuntimeRow> {
  const [row] = await tx
    .insert(schema.runtimes)
    .values({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      name: args.name,
      slug: args.slug,
      createdById: args.userId,
      updatedById: args.userId,
    })
    .returning(runtimeColumns);
  if (!row) throw new Error("runtimes insert returned no row");
  return row;
}

/**
 * The live runtime a host enrollment with no agent binds (the operator path
 * of `tacho enroll`): the runtime named after the host, created when none is.
 * The slug is `slugFromName(hostname)` with a trailing `.local` dropped, and a
 * numeric suffix when another runtime already holds it.
 */
export async function findOrCreateHostRuntime(
  tx: Tx,
  scope: Scope,
  hostname: string,
  userId: string | null,
): Promise<RuntimeRow> {
  const name = hostname.trim().slice(0, 128) || "Unnamed runtime";
  const [existing] = await tx
    .select(runtimeColumns)
    .from(schema.runtimes)
    .where(
      and(
        eq(schema.runtimes.orgId, scope.orgId),
        eq(schema.runtimes.workspaceId, scope.workspaceId),
        sql`lower(${schema.runtimes.name}) = lower(${name})`,
        isNull(schema.runtimes.deletedAt),
      ),
    )
    .orderBy(schema.runtimes.createdAt)
    .limit(1);
  if (existing) return existing;
  const base =
    slugFromName(name.replace(/\.local$/i, ""), RUNTIME_SLUG_MAX) || "runtime";
  let slug = base;
  for (let n = 2; await runtimeSlugTaken(tx, scope, slug); n++) {
    const suffix = `-${n}`;
    slug = `${base.slice(0, RUNTIME_SLUG_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
  }
  return insertRuntime(tx, scope, { name, slug, userId });
}

/** The live agent that already runs `harness` on the runtime, if any. */
export async function runtimeHarnessHolder(
  tx: Tx,
  scope: Scope,
  runtimeId: string,
  harness: string,
  exceptAgentId?: string,
): Promise<{ publicId: string; name: string; slug: string } | null> {
  const [row] = await tx
    .select({
      publicId: schema.agents.publicId,
      name: schema.agents.name,
      slug: schema.agents.slug,
    })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.orgId, scope.orgId),
        eq(schema.agents.workspaceId, scope.workspaceId),
        eq(schema.agents.runtimeId, runtimeId),
        eq(schema.agents.harness, harness),
        isNull(schema.agents.deletedAt),
        ne(schema.agents.status, "archived"),
        exceptAgentId === undefined
          ? undefined
          : ne(schema.agents.id, exceptAgentId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The refusal for a runtime that already runs the harness. It names the
 * agent that holds the pair, because the fix is to move or retire that one.
 */
export function runtimeHarnessTakenError(
  runtime: Pick<RuntimeRow, "name">,
  harness: string,
  holder: { name: string; slug: string } | null,
): HandlerError {
  const who = holder ? ` as agent "${holder.name}" (${holder.slug})` : "";
  return new HandlerError({
    code: "conflict",
    reason: "runtime_harness_taken",
    message: `Runtime "${runtime.name}" already runs ${harness}${who}. One runtime runs one agent per harness.`,
  });
}

/** Refuse when a live agent already runs the harness on the runtime. */
export async function assertRuntimeHarnessFree(
  tx: Tx,
  scope: Scope,
  runtime: RuntimeRow,
  harness: string,
  exceptAgentId?: string,
): Promise<void> {
  const holder = await runtimeHarnessHolder(
    tx,
    scope,
    runtime.id,
    harness,
    exceptAgentId,
  );
  if (holder) throw runtimeHarnessTakenError(runtime, harness, holder);
}

export type AgentVersionChange =
  | "registered"
  | "runtime_changed"
  | "toolbelt_changed";

/**
 * Write the agent's next version and move its current binding in the same
 * transaction (ADR-192). The agent row is locked first so two writes number
 * their versions in order. The new version carries the prior active
 * version's `config` forward, which holds the per-agent budget and
 * containment the host bundle reads. Returns the version number written.
 */
export async function writeAgentVersion(
  tx: Tx,
  args: {
    agentId: string;
    runtimeId: string | null;
    toolbeltId: string | null;
    changeKind: AgentVersionChange;
    userId: string;
    now: Date;
  },
): Promise<number> {
  const [agent] = await tx
    .select({ activeVersionId: schema.agents.activeVersionId })
    .from(schema.agents)
    .where(eq(schema.agents.id, args.agentId))
    .for("update");
  if (!agent) throw new Error("agent row vanished under its version write");
  const [latest] = await tx
    .select({ version: schema.agentVersions.version })
    .from(schema.agentVersions)
    .where(eq(schema.agentVersions.agentId, args.agentId))
    .orderBy(desc(schema.agentVersions.version))
    .limit(1);
  let config: unknown = {};
  if (agent.activeVersionId) {
    const [active] = await tx
      .select({ config: schema.agentVersions.config })
      .from(schema.agentVersions)
      .where(eq(schema.agentVersions.id, agent.activeVersionId))
      .limit(1);
    config = active?.config ?? {};
  }
  const version = (latest?.version ?? 0) + 1;
  const [written] = await tx
    .insert(schema.agentVersions)
    .values({
      agentId: args.agentId,
      version,
      isPublished: true,
      config,
      createdById: args.userId,
      createdAt: args.now,
      runtimeId: args.runtimeId,
      toolbeltId: args.toolbeltId,
      changeKind: args.changeKind,
    })
    .returning({ id: schema.agentVersions.id });
  if (!written) throw new Error("agent_versions insert returned no row");
  await tx
    .update(schema.agents)
    .set({
      activeVersionId: written.id,
      runtimeId: args.runtimeId,
      toolbeltId: args.toolbeltId,
      updatedAt: args.now,
      updatedById: args.userId,
    })
    .where(eq(schema.agents.id, args.agentId));
  return version;
}
