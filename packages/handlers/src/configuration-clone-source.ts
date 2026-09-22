import { schema, withTenantDb } from "@oxagen/database";
import { HandlerError } from "@oxagen/oxagen";
import type { ConfigurationKind } from "@oxagen/oxagen/configuration-clone";
import { agentDefinitionPath } from "@oxagen/oxagen/contracts/agent.propose";
import {
  skillFilePathSchema,
  skillPath,
} from "@oxagen/oxagen/contracts/skill.propose";
import { and, eq, or } from "drizzle-orm";
import {
  resolveSkillRepository,
  type SkillRepository,
} from "./skill-config.repository";
import type { SkillScope } from "./skill-config.store";
import { recordFilePath } from "./context.steering.file";
import { sha256Hex, canonicalJson } from "./registry-digest";

export type ConfigurationSource = {
  kind: ConfigurationKind;
  id: string;
  slug: string;
  name: string;
  source: string;
  files: Array<{ path: string; content: string }>;
  harness:
    | "stella"
    | "claude-code"
    | "codex"
    | "cursor"
    | "claude-agent-sdk"
    | "custom"
    | null;
  repository: SkillRepository;
  constraintEffect?: "require" | "forbid";
};
export function configurationSourceDigest(source: ConfigurationSource) {
  return `sha256:${sha256Hex(canonicalJson({ id: source.id, slug: source.slug, name: source.name, repositoryBindingId: source.repository.bindingId, source: source.source, files: source.files, harness: source.harness, constraintEffect: source.constraintEffect ?? null }))}`;
}
export async function readConfigurationSource(
  scope: SkillScope,
  kind: ConfigurationKind,
  sourceId: string,
): Promise<ConfigurationSource> {
  const repository = await resolveSkillRepository(scope);
  let slug = sourceId;
  let name = sourceId;
  let harness: ConfigurationSource["harness"] = null;
  if (kind === "agent") {
    const [agent] = await withTenantDb((tx) =>
      tx
        .select({
          id: schema.agents.publicId,
          slug: schema.agents.slug,
          name: schema.agents.name,
          harness: schema.agents.harness,
        })
        .from(schema.agents)
        .where(
          and(
            eq(schema.agents.orgId, scope.orgId),
            eq(schema.agents.workspaceId, scope.workspaceId),
            or(
              eq(schema.agents.publicId, sourceId),
              eq(schema.agents.slug, sourceId),
            ),
          ),
        )
        .limit(1),
    );
    if (!agent)
      throw new HandlerError({
        code: "not_found",
        reason: "clone_source_missing",
        message: "The source agent was not found in this workspace",
      });
    slug = agent.slug;
    name = agent.name;
    harness = agent.harness as ConfigurationSource["harness"];
  }
  let constraintEffect: ConfigurationSource["constraintEffect"];
  if (kind === "record") {
    const [record] = await withTenantDb((tx) =>
      tx
        .select({
          slug: schema.contextRecords.slug,
          title: schema.contextRecords.title,
          constraintEffect: schema.contextRecords.constraintEffect,
        })
        .from(schema.contextRecords)
        .where(
          and(
            eq(schema.contextRecords.orgId, scope.orgId),
            eq(schema.contextRecords.workspaceId, scope.workspaceId),
            or(
              eq(schema.contextRecords.publicId, sourceId),
              eq(schema.contextRecords.slug, sourceId),
            ),
          ),
        )
        .limit(1),
    );
    if (record) {
      slug = record.slug;
      name = record.title;
      if (
        record.constraintEffect === "require" ||
        record.constraintEffect === "forbid"
      )
        constraintEffect = record.constraintEffect;
    }
  }
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(slug))
    throw new HandlerError({
      code: "conflict",
      reason: "clone_source_invalid",
      message: "The source identifier is not valid",
    });
  const { github, owner, repo } = repository;
  const head = await github.getBranch({
    owner,
    repo,
    branch: repository.productionBranch,
  });
  if (!head)
    throw new HandlerError({
      code: "not_found",
      reason: "skill_production_branch_missing",
    });
  const path = configurationFilePath(kind, slug);
  const source = await github.getFileContent({
    owner,
    repo,
    path,
    ref: head.sha,
  });
  if (source === null)
    throw new HandlerError({
      code: "not_found",
      reason: "clone_source_missing",
      message: "The configuration has no published repository file",
    });
  if (source.length > 65536)
    throw new HandlerError({
      code: "conflict",
      reason: "clone_source_invalid",
      message: "The source configuration exceeds the supported size",
    });
  const files: ConfigurationSource["files"] = [];
  if (kind === "skill") {
    const root = `.oxagen/skills/${slug}/`;
    const paths = (await github.getTree({ owner, repo, ref: head.sha }))
      .filter((file) => file.startsWith(root) && file !== path)
      .sort();
    if (paths.length > 16)
      throw new HandlerError({
        code: "conflict",
        reason: "clone_bundle_too_large",
        message: "The source skill contains more than 16 companion files",
      });
    for (const file of paths) {
      const relative = skillFilePathSchema.parse(file.slice(root.length));
      const content = await github.getFileContent({
        owner,
        repo,
        path: file,
        ref: head.sha,
      });
      if (content === null || content.length > 65536)
        throw new HandlerError({
          code: "conflict",
          reason: "clone_bundle_invalid",
          message: "A companion file is missing or exceeds the supported size",
        });
      files.push({ path: relative, content });
    }
  }
  return {
    kind,
    id: sourceId,
    slug,
    name,
    source,
    files,
    harness,
    repository,
    ...(constraintEffect ? { constraintEffect } : {}),
  };
}

/** The repository file a configuration of `kind` publishes to. */
export function configurationFilePath(kind: ConfigurationKind, slug: string) {
  return kind === "agent"
    ? agentDefinitionPath(slug)
    : kind === "skill"
      ? skillPath(slug)
      : recordFilePath(slug);
}

/** The proposal branch a configuration of `kind` is proposed on. */
export function configurationBranchName(kind: ConfigurationKind, slug: string) {
  const prefix =
    kind === "agent" ? "agents" : kind === "skill" ? "skills" : "context";
  return `${prefix}/${slug}`;
}

/**
 * Every name a clone of `original` cannot take, read once: the slugs and
 * display names this workspace already holds for the kind, and every file
 * on the production branch. A candidate that clears these still has to
 * clear `configurationBranchTaken`, which is one GitHub call per candidate
 * and so is asked only of the survivors.
 */
export interface TakenConfigurationNames {
  slugs: Set<string>;
  names: Set<string>;
  /** Blob paths at the production branch's head, repository-relative. */
  files: Set<string>;
}

export async function readTakenConfigurationNames(
  scope: SkillScope,
  original: ConfigurationSource,
): Promise<TakenConfigurationNames> {
  const { kind, repository } = original;
  const slugs = new Set<string>();
  const names = new Set<string>();
  await withTenantDb(async (tx) => {
    if (kind === "agent") {
      const rows = await tx
        .select({ slug: schema.agents.slug, name: schema.agents.name })
        .from(schema.agents)
        .where(
          and(
            eq(schema.agents.orgId, scope.orgId),
            eq(schema.agents.workspaceId, scope.workspaceId),
          ),
        );
      for (const row of rows) {
        slugs.add(row.slug);
        names.add(row.name);
      }
    }
    if (kind === "record") {
      const records = await tx
        .select({
          slug: schema.contextRecords.slug,
          title: schema.contextRecords.title,
        })
        .from(schema.contextRecords)
        .where(
          and(
            eq(schema.contextRecords.orgId, scope.orgId),
            eq(schema.contextRecords.workspaceId, scope.workspaceId),
          ),
        );
      for (const row of records) {
        slugs.add(row.slug);
        names.add(row.title);
      }
      const proposals = await tx
        .select({ lineageId: schema.contextProposals.lineageId })
        .from(schema.contextProposals)
        .where(
          and(
            eq(schema.contextProposals.orgId, scope.orgId),
            eq(schema.contextProposals.workspaceId, scope.workspaceId),
          ),
        );
      for (const row of proposals) slugs.add(row.lineageId);
    }
  });
  const { github, owner, repo } = repository;
  const files = new Set(
    await github.getTree({ owner, repo, ref: repository.productionBranch }),
  );
  return { slugs, names, files };
}

/** Whether the proposal branch for `slug` already exists. */
export async function configurationBranchTaken(
  original: ConfigurationSource,
  slug: string,
): Promise<boolean> {
  const { github, owner, repo } = original.repository;
  const branch = configurationBranchName(original.kind, slug);
  return (await github.getBranch({ owner, repo, branch })) !== null;
}

export async function configurationNameTaken(
  scope: SkillScope,
  original: ConfigurationSource,
  slug: string,
  name: string,
) {
  const { kind, repository } = original;
  const rows = await withTenantDb(async (tx) => {
    if (kind === "agent")
      return tx
        .select({ id: schema.agents.id })
        .from(schema.agents)
        .where(
          and(
            eq(schema.agents.orgId, scope.orgId),
            eq(schema.agents.workspaceId, scope.workspaceId),
            or(eq(schema.agents.slug, slug), eq(schema.agents.name, name)),
          ),
        )
        .limit(1);
    if (kind === "record") {
      const records = await tx
        .select({ id: schema.contextRecords.id })
        .from(schema.contextRecords)
        .where(
          and(
            eq(schema.contextRecords.orgId, scope.orgId),
            eq(schema.contextRecords.workspaceId, scope.workspaceId),
            or(
              eq(schema.contextRecords.slug, slug),
              eq(schema.contextRecords.title, name),
            ),
          ),
        )
        .limit(1);
      if (records.length) return records;
      return tx
        .select({ id: schema.contextProposals.id })
        .from(schema.contextProposals)
        .where(
          and(
            eq(schema.contextProposals.orgId, scope.orgId),
            eq(schema.contextProposals.workspaceId, scope.workspaceId),
            eq(schema.contextProposals.lineageId, slug),
          ),
        )
        .limit(1);
    }
    return [];
  });
  if (rows.length) return true;
  const { github, owner, repo } = repository;
  if (
    (await github.getFileContent({
      owner,
      repo,
      path: configurationFilePath(kind, slug),
      ref: repository.productionBranch,
    })) !== null
  )
    return true;
  return configurationBranchTaken(original, slug);
}
