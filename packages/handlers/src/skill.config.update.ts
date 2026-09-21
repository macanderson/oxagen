// audit-exempt: GitHub records the proposal author and merge; snapshots are append-only and the kernel audits publication.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { skillConfigUpdate } from "@oxagen/oxagen/contracts/skill.config.update";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { createSkillConfigService } from "./skill-config.service";
import { postgresSkillConfigStore } from "./skill-config.store";
import { resolveSkillRepository } from "./skill-config.repository";
import { publicSkillConfig } from "./skill.config.get";

export function createSkillConfigUpdateHandler(
  service: ReturnType<typeof createSkillConfigService>,
): CapabilityHandler<typeof skillConfigUpdate> {
  return async (input, ctx) => {
    const actingUserId = await resolveActingUserId(ctx);
    const actor = { ...ctx, userId: actingUserId };
    // INV-29 reads the object literal at the call site, so the acting user is
    // named here rather than through `actor` (packages/handlers/src/role-check.test.ts).
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin"] },
    );
    if (
      input.action === "propose" &&
      input.text !== undefined &&
      input.pullRequestNumber === undefined
    ) {
      return {
        pullRequest: await service.propose(actor, input.text),
        published: null,
      };
    }
    if (
      input.action === "publish" &&
      input.pullRequestNumber !== undefined &&
      input.text === undefined
    ) {
      return {
        pullRequest: null,
        published: publicSkillConfig(
          await service.publish(actor, input.pullRequestNumber),
        ),
      };
    }
    if (
      input.action === "import" &&
      input.text === undefined &&
      input.pullRequestNumber === undefined
    ) {
      return {
        pullRequest: null,
        published: publicSkillConfig(await service.publish(actor)),
      };
    }
    throw new CapabilityError(
      skillConfigUpdate.name,
      "invalid_input",
      "Choose propose with text, publish with a pull request number, or import without either",
    );
  };
}
export const skillConfigUpdateHandler = createSkillConfigUpdateHandler(
  createSkillConfigService({
    repository: resolveSkillRepository,
    store: postgresSkillConfigStore,
    now: () => new Date(),
  }),
);
