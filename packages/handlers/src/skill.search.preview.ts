// audit-exempt: configuration inspection; no skill is loaded and the kernel audits access.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { skillSearchPreview } from "@oxagen/oxagen/contracts/skill.search.preview";
import { estimateSkillTokens } from "@oxagen/oxagen/contracts/skill.propose";
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
import { resolveSkills } from "./skill-resolution";
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
export async function readSkillCatalog(
  repository: SkillRepository,
  commitSha: string,
  source: string,
): Promise<SkillCandidate[]> {
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
  const rows: SkillCandidate[] = [];
  for (let index = 0; index < paths.length; index += 8) {
    rows.push(
      ...(await Promise.all(
        paths.slice(index, index + 8).map(async (path) => {
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
  return rows;
}
export function createSkillSearchPreviewHandler(deps: {
  store: SkillConfigStore;
  repository: typeof resolveSkillRepository;
  catalog: typeof readSkillCatalog;
}): CapabilityHandler<typeof skillSearchPreview> {
  return async (input, ctx) => {
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
    const candidates = await deps.catalog(
      repository,
      head.sha,
      snapshot.config.sources[0]?.id ?? "workspace",
    );
    const result = await resolveSkills(
      snapshot.config,
      candidates,
      async (eligible) => rankSkillDescriptions(input.query, eligible),
    );
    return {
      version: snapshot.version,
      repositoryCommitSha: head.sha,
      ...result,
    };
  };
}
export const skillSearchPreviewHandler = createSkillSearchPreviewHandler({
  store: postgresSkillConfigStore,
  repository: resolveSkillRepository,
  catalog: readSkillCatalog,
});
