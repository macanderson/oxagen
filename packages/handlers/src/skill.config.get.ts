// audit-exempt: read-only configuration history; the kernel audits access.
import { stringify } from "smol-toml";
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { skillConfigGet } from "@oxagen/oxagen/contracts/skill.config.get";
import {
  publishedSkillConfigSchema,
  skillConfigSchema,
} from "@oxagen/oxagen/skills";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import {
  postgresSkillConfigStore,
  type SkillConfigStore,
  type PublishedSkillConfig,
} from "./skill-config.store";
import { readSkillRepositoryBinding } from "./skill-config.repository";

/**
 * The public form of a stored version. The internal binding id stays out of
 * the result. When the caller passes the workspace's current binding, each row
 * says whether it was published under it, which is what `searchable` means.
 */
export function publicSkillConfig(
  row: PublishedSkillConfig,
  current?: { bindingId: string | null },
) {
  const { repositoryBindingId, ...publicRow } = row;
  return publishedSkillConfigSchema.parse(
    current
      ? {
          ...publicRow,
          searchable:
            current.bindingId !== null &&
            repositoryBindingId === current.bindingId,
        }
      : publicRow,
  );
}
export function createSkillConfigGetHandler(
  store: SkillConfigStore,
  binding: typeof readSkillRepositoryBinding = readSkillRepositoryBinding,
): CapabilityHandler<typeof skillConfigGet> {
  return async (input, ctx) => {
    await assertOrgRole(
      { ...ctx, userId: await resolveActingUserId(ctx) },
      { org: ["Owner", "Admin", "Member"], workspace: ["Owner", "Member"] },
    );
    const rows = await store.list(ctx);
    // The binding is read even when a version is named, so every row can say
    // whether `preview_skill_search` will accept it (#3666).
    const active = { bindingId: (await binding(ctx))?.bindingId ?? null };
    const selected = input.version
      ? rows.find(
          (row) => row.id === input.version || row.version === input.version,
        )
      : rows.find(
          (row) =>
            active.bindingId !== null &&
            row.repositoryBindingId === active.bindingId,
        );
    const versions = rows.map((row) => publicSkillConfig(row, active));
    const current = selected ? publicSkillConfig(selected, active) : undefined;
    if (input.version && !current)
      throw new HandlerError({
        code: "not_found",
        reason: "skill_config_missing",
        message:
          "This skill configuration version was not found in the workspace",
      });
    return {
      config: current?.config ?? skillConfigSchema.parse({}),
      draftText: stringify(current?.config ?? skillConfigSchema.parse({})),
      current: current ?? null,
      versions,
    };
  };
}
export const skillConfigGetHandler = createSkillConfigGetHandler(
  postgresSkillConfigStore,
);
