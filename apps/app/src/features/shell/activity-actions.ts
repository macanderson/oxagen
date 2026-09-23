"use server";

import { agentApprovalListResolved } from "@oxagen/oxagen/contracts/agent.approval.list_resolved";
import { notificationsList } from "@oxagen/oxagen/contracts/notification.list";
import { notificationsMark } from "@oxagen/oxagen/contracts/notification.mark";
import { shellNavCountsGet } from "@oxagen/oxagen/contracts/shell.nav_counts.get";
import { dataSource } from "@/data/source";
import { readOk } from "@/data/read";
import { kernelRead, kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

export async function readShellActivity(org: string, ws: string | null) {
  const ctx = await requireViewer(org);
  const source = dataSource();
  const context = await source.shell.context(ctx);
  if (!context.ok) return context;
  const places = context.value.workspaces;
  const orgNotifications = await kernelRead(ctx, {
    contract: notificationsList,
    input: { limit: 100, unreadOnly: false },
    page: "shell",
  });
  const workspaces = [];
  // Recheck each membership before entering its tenant scope. Batch the reads
  // so an organization with many workspaces does not exhaust the connection pool.
  for (let i = 0; i < places.length; i += 4) {
    workspaces.push(
      ...(await Promise.all(
        places.slice(i, i + 4).map(async (place) => {
          const viewer = await requireViewer(org, place.slug);
          const [pending, mandates, counts, resolved, notifications] =
            await Promise.all([
              source.approvals.pending(viewer, { runId: null }),
              source.mandates.list(viewer, { agentId: null }),
              kernelRead(viewer, {
                contract: shellNavCountsGet,
                input: {},
                page: "shell",
              }),
              kernelRead(viewer, {
                contract: agentApprovalListResolved,
                input: {
                  limit: 100,
                  since: new Date(
                    new Date().setUTCHours(0, 0, 0, 0),
                  ).toISOString(),
                },
                page: "shell",
              }),
              kernelRead(viewer, {
                contract: notificationsList,
                input: { limit: 100, unreadOnly: false },
                page: "shell",
              }),
            ]);
          return {
            ...place,
            pending,
            mandates,
            counts,
            resolved,
            notifications,
          };
        }),
      )),
    );
  }
  const notificationReads = [
    { slug: null, read: orgNotifications },
    ...workspaces.map((place) => ({
      slug: place.slug,
      read: place.notifications,
    })),
  ];
  const seen = new Map<
    string,
    {
      notification: import("@oxagen/oxagen/contracts/notification.list").NotificationsListOutput["notifications"][number];
      ws: string | null;
    }
  >();
  for (const entry of notificationReads) {
    if (!entry.read.ok) continue;
    for (const notification of entry.read.value.notifications) {
      if (!seen.has(notification.publicId))
        seen.set(notification.publicId, { notification, ws: entry.slug });
    }
  }
  const notifications = {
    items: [...seen.values()].sort((a, b) =>
      b.notification.createdAt.localeCompare(a.notification.createdAt),
    ),
    partial: notificationReads.some(
      (entry) => !entry.read.ok || entry.read.value.notifications.length >= 100,
    ),
    failures: notificationReads.flatMap((entry) =>
      entry.read.ok ? [] : [{ ws: entry.slug, read: entry.read }],
    ),
  };
  return readOk({
    workspaces,
    notifications,
    currentWorkspace: ws,
    readAt: new Date().toISOString(),
  });
}

export async function markShellNotification(
  org: string,
  ws: string | null,
  id: string,
  archived: boolean,
) {
  const ctx =
    ws === null ? await requireViewer(org) : await requireViewer(org, ws);
  return kernelWrite(ctx, notificationsMark, { id, read: true, archived });
}
