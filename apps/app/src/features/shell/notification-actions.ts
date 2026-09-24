"use server";
// The bell's one write (mockup `markAllRead()`): mark the rows the dialog is
// showing as read. Each row is one `mark_notification`, the governed write the
// API and MCP make, so reading a notification is itself recorded.
//
// The action takes the notification public ids the dialog listed and nothing
// that names a tenant: the workspace comes from the URL slug the viewer is
// resolved against, and the handler marks only rows that belong to the
// authenticated person in this organization.
import { notificationsMark } from "@oxagen/oxagen/contracts/notification.mark";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

/** The most rows one press marks: the feed the dialog lists is at most this long. */
const MARK_LIMIT = 50;

export async function markNotificationsRead(
  org: string,
  ws: string,
  ids: readonly string[],
): Promise<ActionResult<{ marked: number }>> {
  if (ids.length === 0) return { ok: true, value: { marked: 0 } };
  if (ids.length > MARK_LIMIT)
    return { ok: false, reason: "invalid", code: "too_many", field: "ids" };
  const ctx = await requireViewer(org, ws);
  let marked = 0;
  for (const id of ids) {
    const result = await kernelWrite(ctx, notificationsMark, {
      id,
      read: true,
    });
    // The first refusal stops the run and is what the dialog shows: the rows
    // before it stay read, and the count says how many.
    if (!result.ok) return result;
    if (result.value.ok) marked += 1;
  }
  return { ok: true, value: { marked } };
}
