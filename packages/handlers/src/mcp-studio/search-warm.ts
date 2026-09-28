// search-warm.ts: embed a published version's search entries (lane M15;
// mcp-studio-spec, Large servers; ADR-217).
//
// Publish calls this after it projects the version's tools. It embeds every
// search entry the store does not hold under the workspace's target key, in
// batches, then deletes the rows search no longer reads. A workspace that
// ranks by keyword has its rows deleted and sends nothing anywhere. A
// failure here never fails the publish: search embeds what is missing when
// it runs, and ranks by keyword until the vectors exist.
import { contentHash, embeddingTarget, searchEntryTexts, toolManifestSchema } from "@oxagen/mcp-studio";
import type { Bundle } from "@oxagen/oxagen/steering-repo/bundle";
import { logger } from "../logger";
import { PROJECT_CAPABILITY, resolveWorkspace } from "./project";
import { embedderFor, postgresSearchStore, readEmbeddingSettings, searchIndexOf, type SearchScope } from "./search-index";

/** How long publish waits for the warm. The warm keeps going after it. */
export const WARM_WAIT_MS = 15_000;

const warmFailed =
  "The search entries were not embedded at publish, so search embeds them when it runs and ranks by keyword until then.";

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** The value, or "late" once ms pass. The promise keeps running. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | "late"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Embed a published bundle's search entries and sweep the rows search no
 * longer reads. Never throws, and logs only an error's name and counts.
 */
export async function warmSearch(bundle: Bundle, options: { waitMs?: number } = {}): Promise<void> {
  if (bundle.scope !== "workspace" || !bundle.workspace || bundle.tools === null) return;
  let workspaceId: string | undefined;
  try {
    const texts = searchEntryTexts(toolManifestSchema.parse(bundle.tools));
    const ids = await resolveWorkspace(bundle.organization, bundle.workspace);
    workspaceId = ids.workspaceId;
    const scope: SearchScope = { ...ids, principalKind: "service", capabilityName: PROJECT_CAPABILITY };
    const store = postgresSearchStore(scope);
    // No search-mode server, or a workspace that ranks by keyword: no row
    // is read again, so every row goes and nothing is embedded.
    const target = texts.length === 0 ? null : embeddingTarget(await readEmbeddingSettings(scope));
    const embedder = target === null ? null : await embedderFor(target, scope);
    if (embedder === null) {
      const swept = await store.sweep(null);
      if (swept > 0) logger.info({ workspaceId, swept }, "Deleted the search vectors no search reads.");
      return;
    }
    const index = searchIndexOf(embedder, scope, store);
    const hashes = texts.map(contentHash);
    const warming = index.warm(texts).then(async (embedded) => ({ embedded, swept: await store.sweep(index.key, hashes) }));
    const result = await within(warming, options.waitMs ?? WARM_WAIT_MS);
    if (result === "late") {
      logger.info({ workspaceId, count: texts.length }, "The search entries are still embedding after publish.");
      void warming.then(
        (done) => logger.info({ workspaceId, ...done }, "Embedded the search entries after publish."),
        (error: unknown) => logger.warn({ workspaceId, errorName: errorName(error) }, warmFailed),
      );
      return;
    }
    logger.info({ workspaceId, count: texts.length, ...result }, "Embedded the search entries.");
  } catch (error) {
    logger.warn({ workspaceId, errorName: errorName(error) }, warmFailed);
  }
}
