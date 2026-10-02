// tacho-host-cedar.ts: the Cedar policies a Tacho host receives in its
// bundle (lane S12, #4445), compiled once per published version and kept.
//
// Three routes need them, as they need the skills (./tacho-host-skills.ts).
// get_tacho_bundle signs the host's part of the set into the bundle, and
// ingest_tacho_events and fetch_commands build the same bundle for the etag
// the control envelope publishes. The etag covers the Cedar part, so a newly
// published version reaches a host on its next poll.
//
// The set is compiled the way the cloud gateway compiles it
// (`compileDecider` in apps/mcp/src/servers/snapshot.ts), from the same
// published version, so the hook and the gateway decide a call alike.
//
// Every caller reads it outside any tenant transaction, for the reason the
// skills reader gives: the version store's port opens tenant transactions of
// its own.
import type { CapabilityContext } from "@oxagen/oxagen";
import type { Bundle } from "@oxagen/oxagen/steering-repo/bundle";
import { toolManifestSchema } from "@oxagen/mcp-studio";
import {
  cedarTools,
  compilePolicies,
  type CedarRuntime,
  type CompiledPolicySet,
  loadCedarRuntime,
  type ToolManifestLike,
} from "@oxagen/policy";
import { BUNDLE_FEATURE_CEDAR } from "@oxagen/recorder";
import { logger } from "../logger";
import type { TachoPublished } from "../tacho.published";
import type { TachoHostRow } from "./tacho-host";

/** How many published versions the cache holds before it drops the oldest. */
const CEDAR_CACHE_MAX = 256;

/** The published Cedar policies for a host, through one port and its cache. */
export interface HostCedarReader {
  /**
   * The workspace's compiled policy set, for a host that advertised it can
   * parse Cedar, or undefined.
   *
   * Undefined also answers a workspace with no steering repo, one that has
   * published nothing, a version that does not compile, and a read that
   * failed. Each of those leaves the bundle without Cedar, so the host's
   * permission rules decide alone. `capability` names the route in the log
   * lines.
   */
  read(
    capability: string,
    ctx: CapabilityContext,
    host: Pick<TachoHostRow, "bundleFeatures">,
  ): Promise<CompiledPolicySet | undefined>;
}

export interface HostCedarReaderDeps {
  /** Cedar's evaluator, or null when this process has none. `loadCedarRuntime` when unset. */
  cedar?: () => Promise<CedarRuntime | null>;
}

/**
 * One reader per port, as with the skills. Every route bound to the same
 * version store shares its cache, so a published version compiles once per
 * process. A test that binds its own port gets a cache of its own.
 */
const readers = new WeakMap<TachoPublished, HostCedarReader>();

/** The reader for `published`, made on first use and shared after that. */
export function hostCedarReader(published: TachoPublished): HostCedarReader {
  let reader = readers.get(published);
  if (reader === undefined) {
    reader = createHostCedarReader(published);
    readers.set(published, reader);
  }
  return reader;
}

/**
 * A host polls every minute, and a published version never changes, so a
 * version is compiled once and kept. A version that does not compile is kept
 * as null, so it is logged once and not compiled again on every poll. An
 * evaluator that failed to load is not kept, so the next poll tries again.
 */
export function createHostCedarReader(
  published: TachoPublished,
  deps: HostCedarReaderDeps = {},
): HostCedarReader {
  const cedar = deps.cedar ?? loadCedarRuntime;
  const cache = new Map<string, CompiledPolicySet | null>();
  return {
    async read(capability, ctx, host) {
      if (!host.bundleFeatures?.includes(BUNDLE_FEATURE_CEDAR)) {
        return undefined;
      }
      try {
        const { workspace: version } = await published.published({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          runId: null,
        });
        // No steering repo, or nothing published yet. A version that names
        // no workspace comes from an organization repo, which declares no
        // agent of this workspace, so it has no policies for a host either.
        if (version === null || version.workspace === undefined) {
          return undefined;
        }
        const key = [
          ctx.orgId,
          ctx.workspaceId,
          version.repository,
          version.version,
          version.commit,
        ].join("|");
        if (cache.has(key)) return cache.get(key) ?? undefined;
        const runtime = await cedar();
        if (runtime === null) {
          logger.warn(
            { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
            `${capability}: Cedar's evaluator did not load, so the host receives no Cedar policies`,
          );
          return undefined;
        }
        const compiled = compileVersion(
          version,
          version.workspace,
          runtime,
          capability,
          ctx,
        );
        if (cache.size >= CEDAR_CACHE_MAX) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(key, compiled);
        return compiled ?? undefined;
      } catch (error) {
        logger.warn(
          {
            orgId: ctx.orgId,
            workspaceId: ctx.workspaceId,
            err: error instanceof Error ? error.message : String(error),
          },
          `${capability}: the published Cedar policies could not be read, so the host receives none`,
        );
        return undefined;
      }
    },
  };
}

/**
 * The version's policy set, compiled as the gateway compiles it, or null when
 * it does not compile. Publishing checks the same set, so a published version
 * fails here only when something changed since, such as the evaluator.
 */
function compileVersion(
  version: Bundle,
  workspace: string,
  runtime: CedarRuntime,
  capability: string,
  ctx: CapabilityContext,
): CompiledPolicySet | null {
  const where = {
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    repository: version.repository,
    version: version.version,
  };
  let manifest: ToolManifestLike = { servers: [] };
  if (version.tools !== null) {
    const parsed = toolManifestSchema.safeParse(version.tools);
    if (!parsed.success) {
      logger.warn(
        {
          ...where,
          issues: parsed.error.issues.slice(0, 5).map((issue) => issue.message),
        },
        `${capability}: the published tool manifest does not parse, so hosts receive no Cedar policies from this version`,
      );
      return null;
    }
    manifest = parsed.data;
  }
  const tools = cedarTools(manifest);
  if (tools.skipped.length > 0) {
    logger.warn(
      { ...where, skipped: tools.skipped },
      `${capability}: Cedar cannot read some imported tools or arguments. A host decides a call to a skipped tool as builtin__shell, and no rule can read a skipped argument`,
    );
  }
  const result = compilePolicies(
    {
      workspace,
      policies: (version.policies?.policies ?? []).map(({ path, text }) => ({
        path,
        text,
      })),
      agents: version.agents.map(({ name, operator, runtime: on, harness }) => ({
        name,
        operator,
        runtime: on,
        harness,
      })),
      tools: tools.tools,
    },
    runtime,
  );
  if (result.policy_set === undefined) {
    logger.warn(
      { ...where, errors: result.errors.slice(0, 5) },
      `${capability}: the published policies do not compile, so hosts receive no Cedar policies from this version`,
    );
    return null;
  }
  return result.policy_set;
}
