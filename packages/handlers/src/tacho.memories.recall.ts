// tacho.memories.recall.ts: the memories most relevant to one prompt on an
// enrolled host (ADR-206).
//
// The daemon calls this once per prompt, for Claude Code, Codex, Cursor, and
// Stella alike. The handler checks the host key the way every Tacho control
// call does, then asks that the key's creator still holds a role the contract
// grants. It reads the memory records from the workspace's and the
// organization's published steering through the same port as the skills, so
// binding the version store (#4550) changes nothing here. `recallMemories`
// ranks them with the waiting memories governance allows and stamps each
// record it serves.
import type { CapabilityContext, CapabilityHandler } from "@oxagen/oxagen";
import {
  tachoMemoriesRecall,
  type TachoMemoriesRecallOutput,
} from "@oxagen/oxagen/contracts/tacho.memories.recall";
import type { Bundle, BundleRecord } from "@oxagen/oxagen/steering-repo/bundle";
import { MEMORY_DIR } from "@oxagen/oxagen/steering-repo/paths";
import {
  readSteeringRecord,
  recordStatement,
} from "@oxagen/oxagen/steering-repo/record";
import { withTenantDb } from "@oxagen/database";
import type { BundleSource, Delivery } from "@oxagen/steering-bundle";
import { assertContractRole } from "./lib/capability-role-guard";
import { mapConcurrent } from "./lib/map-concurrent";
import { resolveEnrolledHost } from "./lib/tacho-host";
import { logger } from "./logger";
import type {
  ActiveRecord,
  MemoryScope,
  RecallItem,
  RecallRequest,
} from "./memory/types";
import { NOTHING_PUBLISHED, type TachoPublished } from "./tacho.published";

const CAPABILITY = "recall_tacho_memories";

/** How many record files one recall reads at once, as the memory runner does. */
const READS_AT_ONCE = 8;

export interface TachoMemoriesRecallDeps {
  /** The workspace's and the organization's published steering, for the memory records. */
  published: TachoPublished;
  /** Rank and stamp the memories for one request (`recallMemories` in memory/runner). */
  recall(
    scope: MemoryScope,
    request: RecallRequest,
    records: readonly ActiveRecord[],
  ): Promise<RecallItem[]>;
  now?(): Date;
}

/**
 * The memory runner and its Postgres store, loaded on the first call so the
 * handler module stays light for the route that lazy-loads it. Until #4550
 * binds the version store, nothing has published, so recall serves waiting
 * memories only.
 */
export const defaultTachoMemoriesRecallDeps: TachoMemoriesRecallDeps = {
  published: NOTHING_PUBLISHED,
  async recall(scope, request, records) {
    const [{ recallMemories }, { postgresMemoryStore }] = await Promise.all([
      import("./memory/runner"),
      import("./memory/store"),
    ]);
    return recallMemories(postgresMemoryStore, scope, request, records);
  },
};

interface MemoryFile {
  record: BundleRecord;
  source: BundleSource;
  bundle: Bundle;
}

/**
 * The memory records in both published versions. A workspace record wins
 * over an organization record of the same lineage.
 */
function memoryFiles(delivery: Delivery): MemoryFile[] {
  const chosen = new Map<string, MemoryFile>();
  const sources: BundleSource[] = ["organization", "workspace"];
  for (const source of sources) {
    const bundle = delivery[source];
    if (bundle === null) continue;
    for (const record of bundle.records) {
      if (!record.path.startsWith(`${MEMORY_DIR}/`)) continue;
      chosen.set(record.lineage, { record, source, bundle });
    }
  }
  return [...chosen.values()];
}

/**
 * One memory record as recall reads it, or null when the file cannot be read
 * or does not parse. Either is logged, and the other records still reach
 * recall.
 */
async function readMemoryRecord(
  published: TachoPublished,
  ctx: CapabilityContext,
  { record, source, bundle }: MemoryFile,
): Promise<ActiveRecord | null> {
  const where = {
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    source,
    path: record.path,
  };
  let text: string;
  try {
    const content = await published.readAsset(source, bundle, {
      path: record.path,
      blob: record.blob,
    });
    text =
      typeof content === "string" ? content : new TextDecoder().decode(content);
  } catch (error) {
    logger.warn(
      { ...where, err: error instanceof Error ? error.message : String(error) },
      "recall_tacho_memories: a memory record could not be read, so recall leaves it out",
    );
    return null;
  }
  const read = readSteeringRecord(text);
  if (!read.ok) {
    logger.warn(
      where,
      "recall_tacho_memories: a memory record does not parse, so recall leaves it out",
    );
    return null;
  }
  const parsed = read.record;
  return {
    path: record.path,
    lineage: parsed.lineage,
    kind: parsed.kind,
    status: parsed.status,
    statement: recordStatement(read.body),
    repos: parsed.repos ?? null,
    appliesTo: parsed.applies_to ?? null,
    tools: parsed.tools ?? null,
    text,
  };
}

/**
 * The active memory records in the published steering. A version that
 * cannot be read gives none, and recall still serves the waiting memories.
 */
async function publishedMemoryRecords(
  published: TachoPublished,
  ctx: CapabilityContext,
): Promise<ActiveRecord[]> {
  let delivery: Delivery;
  try {
    delivery = await published.published({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      runId: null,
    });
  } catch (error) {
    logger.warn(
      {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        err: error instanceof Error ? error.message : String(error),
      },
      "recall_tacho_memories: the published steering could not be read, so recall serves no records",
    );
    return [];
  }
  const records = await mapConcurrent(
    memoryFiles(delivery),
    READS_AT_ONCE,
    (file) => readMemoryRecord(published, ctx, file),
  );
  return records.filter((record): record is ActiveRecord => record !== null);
}

export function createTachoMemoriesRecallHandler(
  deps: TachoMemoriesRecallDeps,
): CapabilityHandler<typeof tachoMemoriesRecall> {
  return async (input, ctx): Promise<TachoMemoriesRecallOutput> => {
    const host = await withTenantDb((tx) =>
      resolveEnrolledHost(CAPABILITY, ctx, tx as never, input.host_enrollment_id),
    );
    await assertContractRole(tachoMemoriesRecall, ctx);
    const scope: MemoryScope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const [records, recallUnreviewed] = await Promise.all([
      publishedMemoryRecords(deps.published, ctx),
      deps.published.recallUnreviewed(scope),
    ]);
    const items = await deps.recall(
      scope,
      {
        now: deps.now?.() ?? new Date(),
        agent: host.agentKey,
        inApp: false,
        repository: input.repository,
        tools: input.tools,
        paths: input.paths,
        text: input.text,
        recallUnreviewed,
      },
      records,
    );
    return { items };
  };
}

export const tachoMemoriesRecallHandler = createTachoMemoriesRecallHandler(
  defaultTachoMemoriesRecallDeps,
);
