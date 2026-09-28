// tacho.memories.ingest.ts: one memory a harness wrote on an enrolled host
// (ADR-206, "Outside a run").
//
// The daemon's memory reader watches the folders where Claude Code, Codex,
// Cursor, and Stella keep their own memories, and sends each new or changed
// file here. The handler checks the host key the way every Tacho control
// call does, then asks that the key's creator still holds a role the
// contract grants. The memory it stores waits for the curator like any
// other: capture `local_gateway`, the host's agent as its agent, no run, and
// `<harness>:<path>` as its source.
//
// A resend of the same statement from the same file stores nothing, because
// the dedupe key is the capture, the source, and the statement's hash.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import {
  tachoMemoriesIngest,
  type TachoMemoriesIngestOutput,
} from "@oxagen/oxagen/contracts/tacho.memories.ingest";
import { withTenantDb } from "@oxagen/database";
import { assertContractRole } from "./lib/capability-role-guard";
import { resolveEnrolledHost } from "./lib/tacho-host";
import type { MemoryScope } from "./memory/types";

const CAPABILITY = "ingest_tacho_memories";

export interface TachoMemoriesIngestDeps {
  /** Store memories from outside a run (`ingestMemories` in memory/runner). */
  ingest(
    scope: MemoryScope,
    inputs: readonly unknown[],
  ): Promise<{ written: number; refused: number }>;
}

/**
 * The memory runner and its Postgres store, loaded on the first call so the
 * handler module stays light for the route that lazy-loads it.
 */
export const defaultTachoMemoriesIngestDeps: TachoMemoriesIngestDeps = {
  async ingest(scope, inputs) {
    const [{ ingestMemories }, { postgresMemoryStore }] = await Promise.all([
      import("./memory/runner"),
      import("./memory/store"),
    ]);
    return ingestMemories(postgresMemoryStore, scope, inputs);
  },
};

export function createTachoMemoriesIngestHandler(
  deps: TachoMemoriesIngestDeps,
): CapabilityHandler<typeof tachoMemoriesIngest> {
  return async (input, ctx): Promise<TachoMemoriesIngestOutput> => {
    const host = await withTenantDb((tx) =>
      resolveEnrolledHost(CAPABILITY, ctx, tx as never, input.host_enrollment_id),
    );
    await assertContractRole(tachoMemoriesIngest, ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const { written, refused } = await deps.ingest(scope, [
      {
        capture: "local_gateway",
        source: `${input.harness}:${input.path}`,
        statement: input.statement,
        agentLineage: host.agentKey,
        runPublicId: null,
      },
    ]);
    if (refused > 0) {
      // The runner logged the schema's reasons. Sending the same file again
      // would be refused the same way, so the answer is a 400.
      throw new CapabilityError(
        CAPABILITY,
        "invalid_input",
        `The memory from ${input.path} was refused. Change the file to send it again.`,
      );
    }
    return { stored: written > 0 };
  };
}

export const tachoMemoriesIngestHandler = createTachoMemoriesIngestHandler(
  defaultTachoMemoriesIngestDeps,
);
