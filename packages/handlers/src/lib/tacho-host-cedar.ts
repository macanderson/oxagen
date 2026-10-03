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
//
// A host that gets a bundle with no Cedar part decides with its permission
// rules alone, so it allows every call the workspace's `forbid` policies
// refuse. A failed read or a missing evaluator therefore never answers "no
// policies" (#5381). The reader serves the last set it compiled for the
// workspace. With none, it throws `CedarPoliciesUnavailableError`:
// get_tacho_bundle fails, and the host keeps the bundle it holds.
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

/**
 * How many published versions the cache holds before it drops the oldest,
 * and how many workspaces' last good sets the reader keeps.
 */
const CEDAR_CACHE_MAX = 256;

/**
 * The published Cedar policies could not be read, or Cedar's evaluator did
 * not load, and this process holds no earlier set for the workspace.
 *
 * get_tacho_bundle lets it fail the request, so the host keeps the bundle it
 * holds. Ingest and the command poll catch it (`readCedarForEnvelope`).
 */
export class CedarPoliciesUnavailableError extends Error {
  constructor(capability: string, reason: string, options?: ErrorOptions) {
    super(
      `${capability}: ${reason}, and this process holds no earlier Cedar policies for the workspace`,
      options,
    );
    this.name = "CedarPoliciesUnavailableError";
  }
}

/** The published Cedar policies for a host, through one port and its cache. */
export interface HostCedarReader {
  /**
   * The workspace's compiled policy set, for a host that advertised it can
   * parse Cedar, or undefined.
   *
   * Undefined answers a host that did not advertise Cedar, a workspace with
   * no steering repo, one that has published nothing, an organization repo's
   * version, and a version that does not compile. Each leaves the bundle
   * without Cedar, so the host's permission rules decide alone.
   *
   * A read that fails, or an evaluator that did not load, answers the last
   * set this reader compiled for the workspace, so the etag does not move.
   * With no such set, it throws `CedarPoliciesUnavailableError`.
   * `capability` names the route in the log lines.
   */
  read(
    capability: string,
    ctx: CapabilityContext,
    host: Pick<TachoHostRow, "bundleFeatures">,
  ): Promise<CompiledPolicySet | undefined>;
}

/**
 * The policy set for a control envelope's etag, or undefined when the reader
 * has none to give.
 *
 * Ingest and the command poll answer after the host's events or
 * acknowledgements have landed, so a missing set must not fail them. The
 * envelope then names the etag of a bundle without Cedar. A host whose
 * bundle carries Cedar sees a new etag and fetches the bundle.
 * get_tacho_bundle refuses that request on the same error, so the host keeps
 * the bundle it holds.
 */
export async function readCedarForEnvelope(
  reader: HostCedarReader,
  capability: string,
  ctx: CapabilityContext,
  host: Pick<TachoHostRow, "bundleFeatures">,
): Promise<CompiledPolicySet | undefined> {
  try {
    return await reader.read(capability, ctx, host);
  } catch (error) {
    if (!(error instanceof CedarPoliciesUnavailableError)) throw error;
    logger.warn(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId, err: error.message },
      `${capability}: the control envelope's etag leaves Cedar out, so the host's next bundle fetch fails and it keeps the bundle it holds`,
    );
    return undefined;
  }
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
 *
 * The reader also keeps the last set it compiled for each workspace, and
 * serves it when a read fails or the evaluator is missing. An answer of no
 * policies from a read that worked clears it, so a workspace that removed
 * its policies never gets them back from an outage.
 */
export function createHostCedarReader(
  published: TachoPublished,
  deps: HostCedarReaderDeps = {},
): HostCedarReader {
  const cedar = deps.cedar ?? loadCedarRuntime;
  const cache = new Map<string, CompiledPolicySet | null>();
  // By organization and workspace, in order of last use, so the eviction
  // drops the workspace whose last good read is oldest.
  const lastGood = new Map<string, CompiledPolicySet>();

  /**
   * The workspace's set, null for none, or `no_evaluator` when a version
   * needs compiling and Cedar's evaluator did not load. Throws when the
   * published version cannot be read.
   */
  async function current(
    capability: string,
    ctx: CapabilityContext,
  ): Promise<CompiledPolicySet | null | "no_evaluator"> {
    const { workspace: version } = await published.published({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      runId: null,
    });
    // No steering repo, or nothing published yet. A version that names no
    // workspace comes from an organization repo, which declares no agent of
    // this workspace, so it has no policies for a host either.
    if (version === null || version.workspace === undefined) return null;
    const key = [
      ctx.orgId,
      ctx.workspaceId,
      version.repository,
      version.version,
      version.commit,
    ].join("|");
    // Undefined only for a version not compiled yet: a version that does
    // not compile is kept as null.
    const kept = cache.get(key);
    if (kept !== undefined) return kept;
    const runtime = await cedar();
    if (runtime === null) return "no_evaluator";
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
    return compiled;
  }

  function remember(workspace: string, policy: CompiledPolicySet): void {
    lastGood.delete(workspace);
    if (lastGood.size >= CEDAR_CACHE_MAX) {
      const oldest = lastGood.keys().next().value;
      if (oldest !== undefined) lastGood.delete(oldest);
    }
    lastGood.set(workspace, policy);
  }

  /** The workspace's last good set, or the typed error when there is none. */
  function lastGoodOrThrow(
    capability: string,
    ctx: CapabilityContext,
    workspace: string,
    reason: string,
    error?: unknown,
  ): CompiledPolicySet {
    const where = {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      ...(error === undefined
        ? {}
        : { err: error instanceof Error ? error.message : String(error) }),
    };
    const kept = lastGood.get(workspace);
    if (kept === undefined) {
      logger.warn(
        where,
        `${capability}: ${reason}, and this process holds no earlier Cedar policies for the workspace`,
      );
      throw new CedarPoliciesUnavailableError(
        capability,
        reason,
        error === undefined ? undefined : { cause: error },
      );
    }
    logger.warn(
      where,
      `${capability}: ${reason}, so the host receives the last policies that compiled`,
    );
    return kept;
  }

  return {
    async read(capability, ctx, host) {
      if (!host.bundleFeatures?.includes(BUNDLE_FEATURE_CEDAR)) {
        return undefined;
      }
      const workspace = `${ctx.orgId}|${ctx.workspaceId}`;
      let answer: CompiledPolicySet | null | "no_evaluator";
      try {
        answer = await current(capability, ctx);
      } catch (error) {
        return lastGoodOrThrow(
          capability,
          ctx,
          workspace,
          "the published Cedar policies could not be read",
          error,
        );
      }
      if (answer === "no_evaluator") {
        return lastGoodOrThrow(
          capability,
          ctx,
          workspace,
          "Cedar's evaluator did not load",
        );
      }
      if (answer === null) {
        lastGood.delete(workspace);
        return undefined;
      }
      remember(workspace, answer);
      return answer;
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
