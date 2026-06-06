"use server";

import { invoke } from "@oxagen/oxagen";
// Side-effect import: bind every handler into the kernel so invoke() can
// resolve the notifications.* handlers at runtime. Without it invoke() throws
// "No handler registered" (the type system can't catch a missing side-effect
// import). Mirrors conversation-actions.ts pattern.
import "@oxagen/handlers/register";
import { notificationsList } from "@oxagen/oxagen/contracts/notifications.list";
import { notificationsMark } from "@oxagen/oxagen/contracts/notifications.mark";
import type { NotificationsListOutput } from "@oxagen/oxagen/contracts/notifications.list";
import type { NotificationsMarkOutput } from "@oxagen/oxagen/contracts/notifications.mark";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";

/**
 * Build a CapabilityContext from the current Next.js server context.
 * Mirrors the pattern in apps/app server actions (see conversation-actions.ts).
 */
async function buildNotificationCtx(orgSlug: string, workspaceSlug: string) {
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);
  return {
    orgId: org.id,
    workspaceId: ws.id,
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };
}

export async function listNotificationsAction(
  orgSlug: string,
  workspaceSlug: string,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<NotificationsListOutput> {
  const ctx = await buildNotificationCtx(orgSlug, workspaceSlug);
  const input = notificationsList.input.parse({
    unreadOnly: opts.unreadOnly ?? false,
    limit: opts.limit ?? 50,
  });
  const out = await invoke(notificationsList.name, input, ctx, { surface: "agent" });
  return notificationsList.output.parse(out);
}

export async function markNotificationAction(
  orgSlug: string,
  workspaceSlug: string,
  id: string,
  opts: { read?: boolean; archived?: boolean } = {},
): Promise<NotificationsMarkOutput> {
  const ctx = await buildNotificationCtx(orgSlug, workspaceSlug);
  const input = notificationsMark.input.parse({ id, ...opts });
  const out = await invoke(notificationsMark.name, input, ctx, { surface: "agent" });
  return notificationsMark.output.parse(out);
}
