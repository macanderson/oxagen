// audit-exempt: configuration inspection; no skill is loaded and the kernel audits access.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { skillSearchPreview } from "@oxagen/oxagen/contracts/skill.search.preview";
import {
  estimateSkillTokens,
  GRANTING_FRONTMATTER_KEYS,
  scanForSecrets,
} from "@oxagen/oxagen/contracts/skill.propose";
import {
  skillCandidateSchema,
  type SkillCandidate,
} from "@oxagen/oxagen/skills";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import {
  postgresSkillConfigStore,
  type SkillConfigStore,
} from "./skill-config.store";
import {
  resolveSkillRepository,
  type SkillRepository,
} from "./skill-config.repository";
import { readSkillFrontmatter } from "./skill-validation";
import {
  pinnedSkillIds,
  resolveSkills,
  type SkillCatalog,
  type SkillResolution,
} from "./skill-resolution";
import { sha256Hex } from "./registry-digest";

/** Token overlap is deterministic and makes no model call during configuration inspection. */
export function rankSkillDescriptions(
  query: string,
  candidates: readonly SkillCandidate[],
): number[] {
  const terms = [
    ...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []),
  ];
  return candidates.map((candidate) => {
    const words = new Set(
      `${candidate.id} ${candidate.description}`
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? [],
    );
    return terms.length
      ? terms.filter((term) => words.has(term)).length / terms.length
      : 0;
  });
}
/**
 * One tree request, then one content request per pinned skill the tree carries.
 * A skill the configuration does not pin can only be withheld, so its bytes are
 * never fetched: its id comes from the path and its reason from the resolver.
 * The request count therefore follows the approved set, not the catalog, and a
 * repository of a thousand skills under a ten-skill configuration costs eleven
 * requests rather than a thousand and one (#3668).
 */
async function loadSkillCatalog(
  repository: SkillRepository,
  commitSha: string,
  source: string,
  pinned: ReadonlySet<string>,
): Promise<SkillCatalog> {
  const { github, owner, repo } = repository;
  const paths = (await github.getTree({ owner, repo, ref: commitSha })).filter(
    (path) =>
      /^\.oxagen\/skills\/[a-z0-9][a-z0-9-]{0,47}\/SKILL\.md$/.test(path),
  );
  if (paths.length > 1000)
    throw new HandlerError({
      code: "conflict",
      reason: "skill_catalog_too_large",
      message: "The repository skill catalog exceeds 1,000 files",
    });
  const unpinned: string[] = [];
  const read: string[] = [];
  for (const path of paths) {
    const id = path.split("/")[2]!;
    if (pinned.has(id)) read.push(path);
    else unpinned.push(id);
  }
  const candidates: SkillCandidate[] = [];
  for (let index = 0; index < read.length; index += 8) {
    candidates.push(
      ...(await Promise.all(
        read.slice(index, index + 8).map(async (path) => {
          const file = await github.getFileContent({
            owner,
            repo,
            path,
            ref: commitSha,
          });
          const fm = file === null ? null : readSkillFrontmatter(file);
          const id = path.split("/")[2];
          if (!file || !fm || fm.fields.name !== id || !fm.fields.scope)
            throw new HandlerError({
              code: "conflict",
              reason: "skill_catalog_invalid",
              message: "A published skill has invalid frontmatter",
            });
          // A pinned file on the production branch can change without passing
          // propose_skill's checks, so the catalog repeats the two that guard
          // what a candidate carries: no frontmatter key may grant authority,
          // and no credential may reach a description or a load.
          if (
            GRANTING_FRONTMATTER_KEYS.some((key) =>
              Object.hasOwn(fm.fields, key),
            ) ||
            scanForSecrets(file) !== null
          )
            throw new HandlerError({
              code: "conflict",
              reason: "skill_catalog_unsafe",
              message:
                "A published skill grants authority or carries a credential",
            });
          return skillCandidateSchema.parse({
            id,
            version: fm.fields.version,
            digest: `sha256:${sha256Hex(file.replace(/\r\n/g, "\n"))}`,
            source,
            description: fm.fields.description ?? "",
            tokenCost: estimateSkillTokens(file),
          });
        }),
      )),
    );
  }
  return { candidates, unpinned };
}
// Immutable commits need one catalog read per process. Bound the retained metadata
// and coalesce concurrent requests; failed reads are never cached. The pinned set
// is part of the key because it decides which files the read fetched.
const catalogCache = new Map<string, Promise<SkillCatalog>>();
const MAX_CACHED_CATALOGS = 8;
export async function readSkillCatalog(
  repository: SkillRepository,
  commitSha: string,
  source: string,
  pinned: ReadonlySet<string>,
): Promise<SkillCatalog> {
  const key = JSON.stringify([
    repository.bindingId,
    repository.owner,
    repository.repo,
    commitSha,
    source,
    sha256Hex([...pinned].sort().join("\n")),
  ]);
  let promise = catalogCache.get(key);
  if (!promise) {
    while (catalogCache.size >= MAX_CACHED_CATALOGS)
      catalogCache.delete(catalogCache.keys().next().value!);
    promise = loadSkillCatalog(repository, commitSha, source, pinned);
    catalogCache.set(key, promise);
    const pending = promise;
    void pending.catch(() => {
      if (catalogCache.get(key) === pending) catalogCache.delete(key);
    });
  }
  const catalog = await promise;
  return {
    candidates: catalog.candidates.map((row) => ({ ...row })),
    unpinned: [...catalog.unpinned],
  };
}
export type SkillSearchDeps = {
  store: SkillConfigStore;
  repository: typeof resolveSkillRepository;
  catalog: typeof readSkillCatalog;
};

export const skillSearchDeps: SkillSearchDeps = {
  store: postgresSkillConfigStore,
  repository: resolveSkillRepository,
  catalog: readSkillCatalog,
};

/**
 * The resolution both skill-search capabilities read: one role gate, one snapshot,
 * one catalog read and one resolver. The capability that called it decides how much
 * of the answer its caller may see.
 */
export function createSkillSearchResolver(deps: SkillSearchDeps) {
  return async (
    input: { version: string; query: string },
    ctx: Parameters<CapabilityHandler<typeof skillSearchPreview>>[1],
  ): Promise<{
    version: string;
    repositoryCommitSha: string;
    resolution: SkillResolution;
  }> => {
    await assertOrgRole(
      { ...ctx, userId: await resolveActingUserId(ctx) },
      { org: ["Owner", "Admin", "Member"], workspace: ["Owner", "Member"] },
    );
    const snapshot = (await deps.store.list(ctx)).find(
      (row) => row.id === input.version || row.version === input.version,
    );
    if (!snapshot)
      throw new HandlerError({
        code: "not_found",
        reason: "skill_config_missing",
        message:
          "This skill configuration version was not found in the workspace",
      });
    const repository = await deps.repository(ctx);
    if (repository.bindingId !== snapshot.repositoryBindingId)
      throw new HandlerError({
        code: "conflict",
        reason: "skill_repository_changed",
        message: "This configuration belongs to an earlier repository binding",
      });
    const head = await repository.github.getBranch({
      owner: repository.owner,
      repo: repository.repo,
      branch: repository.productionBranch,
    });
    if (!head)
      throw new HandlerError({
        code: "not_found",
        reason: "skill_production_branch_missing",
        message: "The approved production branch no longer exists",
      });
    const source = snapshot.config.sources[0]?.id ?? "workspace";
    const catalog = await deps.catalog(
      repository,
      head.sha,
      source,
      pinnedSkillIds(snapshot.config, source),
    );
    const resolution = await resolveSkills(
      snapshot.config,
      catalog,
      async (eligible) => rankSkillDescriptions(input.query, eligible),
    );
    return {
      version: snapshot.version,
      repositoryCommitSha: head.sha,
      resolution,
    };
  };
}

/** The person's projection: every withheld skill by name and reason. */
export function createSkillSearchPreviewHandler(
  deps: SkillSearchDeps,
): CapabilityHandler<typeof skillSearchPreview> {
  const resolve = createSkillSearchResolver(deps);
  return async (input, ctx) => {
    const { version, repositoryCommitSha, resolution } = await resolve(
      input,
      ctx,
    );
    return {
      version,
      repositoryCommitSha,
      results: resolution.results,
      withheld: resolution.withheld,
      tokenCost: resolution.tokenCost,
    };
  };
}
export const skillSearchPreviewHandler =
  createSkillSearchPreviewHandler(skillSearchDeps);
