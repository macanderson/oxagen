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

export function publicSkillConfig(row: PublishedSkillConfig) {
  const { repositoryBindingId: _binding, ...publicRow } = row;
  return publishedSkillConfigSchema.parse(publicRow);
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
    const currentBinding = input.version ? undefined : await binding(ctx);
    const selected = input.version
      ? rows.find(
          (row) => row.id === input.version || row.version === input.version,
        )
      : rows.find(
          (row) => row.repositoryBindingId === currentBinding?.bindingId,
        );
    const versions = rows.map(publicSkillConfig);
    const current = selected ? publicSkillConfig(selected) : undefined;
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
