"use server";
// The Memories tab's two writes (memory-collection spec, Promotion and
// Lifecycle; #4914), each through the kernel seam for the workspace viewer
// the URL names. Both contracts are `noBillingGate`, and both handlers gate
// the role with the contract's own defaultRoles: an org Owner or Admin, or a
// workspace Owner or Member. A workspace Viewer is answered `denied` with
// nothing changed.
//
// promote_memories adds one draft record per entry to the open memory PR, or
// opens one on today's memory branch. Nothing steers until a person merges
// it. dismiss_memories sets memories aside, so the curator does not propose
// their statements again, and with `restore` brings them back to waiting.
import { steeringMemoriesDismiss } from "@oxagen/oxagen/contracts/steering.memories.dismiss";
import { steeringMemoriesPromote } from "@oxagen/oxagen/contracts/steering.memories.promote";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

type PromoteInput = (typeof steeringMemoriesPromote)["input"]["_input"];

/** What the tab says once promote_memories answered. */
type MemoriesPromoted = {
  /** The memory PR the drafts are on; null when no draft was left to add. */
  pullRequest: { number: number; url: string; opened: boolean } | null;
  /** Records added to the memory PR. */
  records: number;
  /** Memories no record cites, because they had moved on or were already proposed. */
  skipped: number;
};

/** Add one draft record per entry to the memory PR. The memories turn In PR. */
export async function promoteMemories(
  org: string,
  ws: string,
  drafts: PromoteInput["drafts"],
): Promise<ActionResult<MemoriesPromoted>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, steeringMemoriesPromote, {
    drafts,
    same_text: true,
  });
  if (!result.ok) return result;
  const pr = result.value.pull_request;
  return {
    ok: true,
    value: {
      pullRequest:
        pr === null
          ? null
          : { number: pr.number, url: pr.url, opened: pr.opened },
      records: result.value.records.length,
      skipped: result.value.skipped.length,
    },
  };
}

/** What the tab says once dismiss_memories answered. */
type MemoriesDismissed = { changed: number; skipped: number };

/** Dismiss the memories, or with `restore` bring dismissed ones back to waiting. */
export async function dismissMemories(
  org: string,
  ws: string,
  memoryIds: string[],
  restore: boolean,
): Promise<ActionResult<MemoriesDismissed>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, steeringMemoriesDismiss, {
    memory_ids: memoryIds,
    restore,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    value: {
      changed: result.value.changed.length,
      skipped: result.value.skipped.length,
    },
  };
}
