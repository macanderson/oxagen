// tacho-host-skills.ts: the published skills a Tacho host receives in its
// bundle, read once per pair of published versions and kept.
//
// Three routes need them. get_tacho_bundle signs them into the bundle, and
// ingest_tacho_events and fetch_commands fold them into the etag the control
// envelope publishes (`servedBundleEtag` in ./tacho-host). The envelope's etag
// has to be the one the host holds, or the daemon refetches the bundle on
// every envelope.
//
// Every caller reads them outside any tenant transaction. The version store's
// port opens tenant transactions of its own and reads the forge, so a read
// made inside one would hold a pool connection while it waits for another,
// which exhausts the pool under load (`withTransactionOrgWideRead` in
// `@oxagen/database` explains).
import type { CapabilityContext } from "@oxagen/oxagen";
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
} from "@oxagen/recorder";
import { encodeSkill } from "@oxagen/recorder/skills";
import { logger } from "../logger";
import type { TachoPublished } from "../tacho.published";
import type { TachoHostRow } from "./tacho-host";

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

/** The published skills for a host, through one port and its cache. */
export interface HostSkillsReader {
  /**
   * The skills for a host that advertised it can parse them, or undefined.
   *
   * Undefined also answers a workspace that publishes no skills, and a read
   * that failed. Each of those leaves the bundle, and its etag, as the policy
   * alone makes them. `capability` names the route in the log lines.
   */
  read(
    capability: string,
    ctx: CapabilityContext,
    host: Pick<TachoHostRow, "bundleFeatures">,
  ): Promise<BundleSkill[] | undefined>;
}

/**
 * One reader per port. Every route bound to the same version store shares its
 * cache, so a published version's skills are read once per process and not
 * once per route. A test that binds its own port gets a cache of its own.
 */
const readers = new WeakMap<TachoPublished, HostSkillsReader>();

/** The reader for `published`, made on first use and shared after that. */
export function hostSkillsReader(published: TachoPublished): HostSkillsReader {
  let reader = readers.get(published);
  if (reader === undefined) {
    reader = createHostSkillsReader(published);
    readers.set(published, reader);
  }
  return reader;
}

/**
 * A host polls every minute, and a published version never changes, so the
 * skills are read once per pair of published versions and kept. A skill that
 * does not fit the bundle's schema or its caps is left out and logged, and a
 * published version that cannot be read sends no skills. Neither stops the
 * mandate: a host that cannot receive its skills still receives its
 * permissions.
 */
function createHostSkillsReader(published: TachoPublished): HostSkillsReader {
  const cache = new Map<string, CachedSkills>();
  return {
    async read(capability, ctx, host) {
      if (!host.bundleFeatures?.includes(BUNDLE_FEATURE_SKILLS)) {
        return undefined;
      }
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
          const read = await readSkills(published, delivery, capability, ctx);
          // A skill scoped to repositories is left out: the bundle is per
          // host, and a host runs sessions in many repositories.
          cached = {
            skills: fitSkills(read.chosen, capability, ctx),
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
          `${capability}: the published skills could not be read, so the host receives none`,
        );
        return undefined;
      }
    },
  };
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
  capability: string,
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
          `${capability}: the skill was left out, because one of its files could not be read`,
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
  capability: string,
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
        `${capability}: the skill was left out, because it ${refusal}`,
      );
      continue;
    }
    chars += size;
    skills.push(parsed.data);
  }
  return skills;
}
