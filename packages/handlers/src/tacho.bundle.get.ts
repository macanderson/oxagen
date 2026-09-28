import type { CapabilityContext, CapabilityHandler } from "@oxagen/oxagen";
import { tachoBundleGet } from "@oxagen/oxagen/contracts/tacho.bundle.get";
import { schema, withTenantDb } from "@oxagen/database";
import type { Bundle } from "@oxagen/oxagen/steering-repo/bundle";
import type { BundleSource, Delivery } from "@oxagen/steering-bundle";
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
import {
  type TachoPublished,
  VERSION_STORE_PUBLISHED,
} from "./tacho.published";

export interface TachoBundleGetDeps {
  /** The workspace's and the organization's published steering, for the skills. */
  published: TachoPublished;
}

/** The skills come from the versions the Postgres version store holds (#4550). */
export const defaultTachoBundleGetDeps: TachoBundleGetDeps = {
  published: VERSION_STORE_PUBLISHED,
};

/** How many published pairs the skills cache holds before it drops the oldest. */
const SKILLS_CACHE_MAX = 256;

/**
 * How long skills read with a skill left out are kept. A forge error may pass,
 * so the left-out skill is tried again after this. A file that never reads,
 * such as a binary asset, costs one forge read per ten minutes.
 */
const SKILLS_PARTIAL_TTL_MS = 10 * 60 * 1000;

interface CachedSkills {
  skills: BundleSkill[];
  /** When a read that left a skill out stops answering, in epoch milliseconds. */
  expiresAt?: number;
}

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
  cache: Map<string, CachedSkills>,
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
    let cached = cache.get(key);
    if (cached?.expiresAt !== undefined && cached.expiresAt <= Date.now()) {
      cache.delete(key);
      cached = undefined;
    }
    if (cached === undefined) {
      const read = await readSkills(published, delivery, ctx);
      // A skill scoped to repositories is left out: the bundle is per host,
      // and a host runs sessions in many repositories.
      cached = {
        skills: fitSkills(read.chosen, ctx),
        ...(read.partial
          ? { expiresAt: Date.now() + SKILLS_PARTIAL_TTL_MS }
          : {}),
      };
      if (cache.size >= SKILLS_CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, cached);
    }
    return cached.skills.length === 0 ? undefined : cached.skills;
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

/**
 * The published skills, with each skill whose files cannot be read left out.
 *
 * `runSkills` reads each skill's files in turn and throws on the first one it
 * cannot read or parse. The file it last asked for names the skill that
 * failed, so that skill is left out, logged, and the rest read again. Every
 * read goes to the version object `published` returned, because the port
 * finds a version's repository by that object.
 */
async function readSkills(
  published: TachoPublished,
  delivery: Delivery,
  ctx: CapabilityContext,
): Promise<{
  chosen: Awaited<ReturnType<typeof runSkills>>;
  partial: boolean;
}> {
  const dropped = new Set<string>();
  for (;;) {
    // `runSkills` reads one file at a time, so one holder tracks the last read.
    const last: { source?: BundleSource; path?: string } = {};
    try {
      const chosen = await runSkills(
        withoutSkills(delivery, dropped),
        null,
        (source, _copy, file) => {
          last.source = source;
          last.path = file.path;
          const bundle = delivery[source];
          if (bundle === null) {
            throw new Error(`No ${source} version holds ${file.path}.`);
          }
          return published.readAsset(source, bundle, file);
        },
      );
      return { chosen, partial: dropped.size > 0 };
    } catch (error) {
      const failed =
        last.source === undefined || last.path === undefined
          ? []
          : skillsReading(delivery[last.source], last.path).filter(
              (lineage) => !dropped.has(lineage),
            );
      if (failed.length === 0) throw error;
      for (const lineage of failed) {
        dropped.add(lineage);
        logger.warn(
          {
            orgId: ctx.orgId,
            workspaceId: ctx.workspaceId,
            lineage,
            path: last.path,
            err: error instanceof Error ? error.message : String(error),
          },
          "get_tacho_bundle: the skill was left out, because one of its files could not be read",
        );
      }
    }
  }
}

/** The lineages of the skills in `bundle` that read `path`. */
function skillsReading(bundle: Bundle | null, path: string): string[] {
  if (bundle === null) return [];
  return bundle.records
    .filter(
      (record) =>
        record.kind === "skill" &&
        (record.path === path ||
          (record.files ?? []).some((file) => file.path === path)),
    )
    .map((record) => record.lineage);
}

/** The delivery with the skills of `lineages` removed from both versions. */
function withoutSkills(delivery: Delivery, lineages: Set<string>): Delivery {
  if (lineages.size === 0) return delivery;
  const keep = (bundle: Bundle | null): Bundle | null =>
    bundle === null
      ? null
      : {
          ...bundle,
          records: bundle.records.filter(
            (record) => record.kind !== "skill" || !lineages.has(record.lineage),
          ),
        };
  return {
    ...delivery,
    workspace: keep(delivery.workspace),
    organization: keep(delivery.organization),
  };
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
  const skillsCache = new Map<string, CachedSkills>();
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
