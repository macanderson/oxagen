"use server";
// The assistant flyout's thread, read back when the flyout opens (#4163).
// `ask_assistant` has always written each turn to a conversation in Postgres,
// but the flyout kept its thread only in component state, so a reload showed
// an empty panel over a conversation that was still on the record, and a
// workspace rename stranded the thread under the old slug. This reads the
// viewer's latest active conversation in the workspace through the
// `conversations` port and answers the workspace's stable id beside it, which
// the flyout keys its thread by instead of the slug.
//
// The one read of the `DataSource` from a feature action beside
// `choice-actions.ts` (ADR-167): the port holds the kernel call, the mapping
// and the view-model check that keeps every id a public id (INV-11).
import type { AssistantThread } from "@/data/contracts/conversations";
import { dataSource } from "@/data/source";
import type { ActionResult } from "@/server/kernel";
import { readToActionResult } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

export type LoadedThread = {
  /**
   * The workspace's internal id: the key the flyout files the thread under.
   * A rename changes the slug in the URL and never this. It is a map key
   * only, and nothing draws it.
   */
  workspaceKey: string;
  /** The viewer's latest active conversation here, or null for none. */
  thread: AssistantThread | null;
};

/** Read the thread the flyout reopens in `ws`. */
export async function loadAssistantThread(
  org: string,
  ws: string,
): Promise<ActionResult<LoadedThread>> {
  const ctx = await requireViewer(org, ws);
  const read = await dataSource().conversations.latest(ctx);
  if (!read.ok) return readToActionResult<LoadedThread>(read);
  return {
    ok: true,
    value: { workspaceKey: ctx.workspaceId, thread: read.value },
  };
}
