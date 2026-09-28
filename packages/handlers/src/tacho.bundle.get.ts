import type { CapabilityContext, CapabilityHandler } from "@oxagen/oxagen";
import { tachoBundleGet } from "@oxagen/oxagen/contracts/tacho.bundle.get";
import { schema, withTenantDb } from "@oxagen/database";
import { runSkills } from "@oxagen/steering-bundle/session";
import {
  BUNDLE_FEATURE_SKILLS,
  BUNDLE_SKILLS_CHARS_MAX,
  BUNDLE_SKILLS_MAX,
  type BundleSkill,
  bundleSkillChars,
  bundleSkillSchema,
  digestJcs,
  type JsonValue,
} from "@oxagen/tacho";
import { encodeSkill } from "@oxagen/tacho/skills";
import { eq } from "drizzle-orm";
import {
  readDenyGeneration,
  readWorkspaceRetention,
  requireBundleSigner,
  resolveEnrolledHost,
  resolveHostMandate,
  signBundle,
  unsignedBundle,
} from "./lib/tacho-host";
import { readWorkspaceSteering } from "./lib/tacho-steering";
import { logger } from "./logger";
import { NOTHING_PUBLISHED, type TachoPublished } from "./tacho.published";

export interface TachoBundleGetDeps {
  /** The workspace's and the organization's published steering, for the skills. */
  published: TachoPublished;
}

/** Until #4550 binds the version store, nothing has published, so no bundle carries skills. */
export const defaultTachoBundleGetDeps: TachoBundleGetDeps = {
  published: NOTHING_PUBLISHED,
};

/** How many published pairs the skills cache holds before it drops the oldest. */
const SKILLS_CACHE_MAX = 256;

type HostRow = Awaited<ReturnType<typeof resolveEnrolledHost>>;

/**
 * The skills for a host that advertised it can parse them, or undefined.
 *
 * A host polls every minute, and a published version never changes, so the
 * skills are read once per pair of published versions and kept. A skill
 * that does not fit the bundle's schema or its caps is left out and logged,
 * and a published version that cannot be read sends no skills. Neither stops
 * the mandate: a host that cannot receive its skills still receives its
 * permissions.
 */
async function hostSkills(
  published: TachoPublished,
  cache: Map<string, BundleSkill[]>,
  ctx: CapabilityContext,
  host: HostRow,
): Promise<BundleSkill[] | undefined> {
  if (!host.bundleFeatures?.includes(BUNDLE_FEATURE_SKILLS)) return undefined;
  try {
    const delivery = await published.published({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      runId: null,
    });
    if (delivery.workspace === null && delivery.organization === null) {
      return undefined;
    }
    const key = [
      ctx.orgId,
      ctx.workspaceId,
      `${delivery.workspace?.commit ?? "-"}@${delivery.workspace?.version ?? 0}`,
      `${delivery.organization?.commit ?? "-"}@${delivery.organization?.version ?? 0}`,
    ].join("|");
    let skills = cache.get(key);
    if (skills === undefined) {
      // A skill scoped to repositories is left out: the bundle is per host,
      // and a host runs sessions in many repositories.
      skills = fitSkills(
        await runSkills(delivery, null, published.readAsset),
        ctx,
      );
      if (cache.size >= SKILLS_CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, skills);
    }
    return skills.length === 0 ? undefined : skills;
  } catch (error) {
    logger.warn(
      {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        err: error instanceof Error ? error.message : String(error),
      },
      "get_tacho_bundle: the published skills could not be read, so the bundle carries none",
    );
    return undefined;
  }
}

/** The skills that fit the bundle, in the order `runSkills` gives them. */
function fitSkills(
  chosen: Awaited<ReturnType<typeof runSkills>>,
  ctx: CapabilityContext,
): BundleSkill[] {
  const skills: BundleSkill[] = [];
  let chars = 0;
  for (const skill of chosen) {
    const parsed = bundleSkillSchema.safeParse(encodeSkill(skill));
    const size = parsed.success ? bundleSkillChars(parsed.data) : 0;
    const refusal = !parsed.success
      ? "does not fit the bundle's skill schema"
      : skills.length >= BUNDLE_SKILLS_MAX
        ? `would pass ${BUNDLE_SKILLS_MAX} skills`
        : chars + size > BUNDLE_SKILLS_CHARS_MAX
          ? `would pass ${BUNDLE_SKILLS_CHARS_MAX} characters of skills`
          : null;
    if (refusal !== null || !parsed.success) {
      logger.warn(
        { orgId: ctx.orgId, workspaceId: ctx.workspaceId, lineage: skill.lineage },
        `get_tacho_bundle: the skill was left out, because it ${refusal}`,
      );
      continue;
    }
    chars += size;
    skills.push(parsed.data);
  }
  return skills;
}

/**
 * The signed policy bundle for the calling host. In this phase the bundle is
 * observe-mode with no rules: the shape, signing, etag, and status plumbing
 * are what the collector depends on; the IAM compiler that fills
 * `permissions` and `tools` lands with the authority phase (plan PR 6).
 * `context.system` carries the workspace's `must` and `should` steering
 * records (ADR-091), which the collector hands the agent at session start.
 * `skills` carries the published skills, which the collector places where
 * the harness reads user skills at session start.
 */
export function createTachoBundleGetHandler(
  deps: TachoBundleGetDeps,
): CapabilityHandler<typeof tachoBundleGet> {
  const skillsCache = new Map<string, BundleSkill[]>();
  return async (input, ctx) => {
    const now = new Date();
    const signer = requireBundleSigner("get_tacho_bundle");
    return withTenantDb(async (tx) => {
      const host = await resolveEnrolledHost(
        "get_tacho_bundle",
        ctx,
        tx as never,
        input.host_enrollment_id,
      );
      const [denyGeneration, retention, steering, mandate, skills] =
        await Promise.all([
          readDenyGeneration(tx as never, ctx.orgId, ctx.workspaceId),
          readWorkspaceRetention(tx as never, ctx.orgId, ctx.workspaceId),
          readWorkspaceSteering(tx as never, ctx.orgId, ctx.workspaceId),
          resolveHostMandate(tx as never, ctx, host),
          hostSkills(deps.published, skillsCache, ctx, host),
        ]);
      const built = unsignedBundle(
        host,
        denyGeneration,
        retention,
        steering,
        mandate,
        now,
      );
      // The etag covers the skills too, so a new published version reaches
      // a host that polls with its etag. A bundle with no skills keeps the
      // etag `unsignedBundle` gives it.
      const etag =
        skills === undefined
          ? built.etag
          : digestJcs({
              policy: built.etag,
              skills,
            } as unknown as JsonValue).slice(
              "sha256:".length,
              "sha256:".length + 32,
            );
      // `version` counts mandate changes, not fetches: the same etag keeps the
      // version it was served with, so a version sealed into a frame names one
      // mandate. That holds for the copy signed again when a host renews a quiet
      // mandate by polling without its etag (`pollEtag` in `@oxagen/tacho`).
      const unsigned = {
        ...built,
        etag,
        version:
          (host.bundleEtagServed === etag ? host.bundleVersionServed : null) ??
          built.version,
        ...(skills === undefined ? {} : { skills }),
      };
      await tx
        .update(schema.tachoHosts)
        .set({
          lastBundleFetchAt: now,
          lastSeenAt: now,
          bundleEtagServed: unsigned.etag,
          bundleVersionServed: unsigned.version,
          denyGenerationOrgSeen: denyGeneration.org,
          denyGenerationWsSeen: denyGeneration.workspace,
          updatedAt: now,
        })
        .where(eq(schema.tachoHosts.id, host.id));
      if (input.etag !== undefined && input.etag === unsigned.etag) {
        return { not_modified: true, etag: unsigned.etag, bundle: null };
      }
      return {
        not_modified: false,
        etag: unsigned.etag,
        bundle: signBundle(signer, unsigned),
      };
    });
  };
}

export const tachoBundleGetHandler = createTachoBundleGetHandler(
  defaultTachoBundleGetDeps,
);
