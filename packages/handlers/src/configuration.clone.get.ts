// audit-exempt: the draft reads configuration and suggests an unused name without writing.
import { type CapabilityHandler, HandlerError } from "@oxagen/oxagen";
import { configurationCloneGet } from "@oxagen/oxagen/contracts/configuration.clone.get";
import { configurationCloneName } from "@oxagen/oxagen/configuration-clone";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import {
  configurationBranchTaken,
  configurationFilePath,
  configurationSourceDigest,
  readConfigurationSource,
  readTakenConfigurationNames,
} from "./configuration-clone-source";
import { clonedConfigurationText } from "./configuration-clone-draft";

export function createConfigurationCloneGetHandler(
  deps = {
    source: readConfigurationSource,
    taken: readTakenConfigurationNames,
    branchTaken: configurationBranchTaken,
  },
): CapabilityHandler<typeof configurationCloneGet> {
  return async (input, ctx) => {
    await assertOrgRole(
      { ...ctx, userId: await resolveActingUserId(ctx) },
      { org: ["Owner", "Admin"] },
    );
    const original = await deps.source(ctx, input.kind, input.sourceId);
    const maximum =
      input.kind === "agent" ? 18 : input.kind === "skill" ? 48 : 200;
    // The workspace's names and the production tree are read once, and
    // the one GitHub call per candidate (its proposal branch) is made only
    // for a candidate the local reads did not rule out. The old loop asked
    // one query and two GitHub calls per ordinal, up to 1,000 times.
    const taken = await deps.taken(ctx, original);
    for (let ordinal = 0; ordinal < 1000; ordinal++) {
      const candidate = configurationCloneName(
        original.slug,
        original.name,
        ordinal,
        maximum,
      );
      if (input.kind === "skill") candidate.name = candidate.slug;
      if (
        taken.slugs.has(candidate.slug) ||
        taken.names.has(candidate.name) ||
        taken.files.has(configurationFilePath(input.kind, candidate.slug))
      )
        continue;
      if (await deps.branchTaken(original, candidate.slug)) continue;
      return {
        kind: input.kind,
        sourceId: input.sourceId,
        sourceDigest: configurationSourceDigest(original),
        ...candidate,
        source: clonedConfigurationText(
          original,
          candidate.slug,
          candidate.name,
        ),
        files: original.files,
        harness: original.harness,
      };
    }
    throw new HandlerError({
      code: "conflict",
      reason: "clone_name_exhausted",
      message:
        "The first 1,000 clone names are occupied. Choose another source name.",
    });
  };
}
export const configurationCloneGetHandler =
  createConfigurationCloneGetHandler();
