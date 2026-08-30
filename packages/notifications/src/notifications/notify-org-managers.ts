import { and, eq, inArray } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { sendEmail } from "../send-email";
import { createNotification } from "./create-notification";
import type { NotificationKind } from "./types";
import { logger } from "../logger";

/** Default org-level roles that receive auth-alert notifications. */
const DEFAULT_ALERT_ROLES = ["Owner", "Admin"] as const;

/** Org setting key. Typed narrowly to avoid `any`. */
interface McpAuthAlertsSetting {
  send_email?: boolean;
  roles?: string[];
}

/**
 * A resolved recipient — userId + email address.
 * Exported so tests and callers can inject via _recipientsOverride.
 */
export interface NotificationRecipient {
  userId: string;
  email: string;
}

export interface NotifyOrgManagersInput {
  orgId: string;
  workspaceId?: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  deepLink?: string;
  /** Pre-rendered HTML body for the email (callers use reauthEmailTemplate). */
  emailHtml: string;
  /** Override the send_email setting (useful for callers that have already resolved it). */
  emailDisabled?: boolean;
  /**
   * Inject recipients directly — for unit testing only.
   * Production callers omit this and let the function resolve from DB.
   */
  _recipientsOverride?: NotificationRecipient[];
}

/**
 * Resolve org managers whose role ∈ mcp_auth_alerts.roles (default Owner/Admin),
 * create one in-app notification per recipient, and — unless send_email is false —
 * send an email to each and stamp emailedAt.
 *
 * Email failures do NOT prevent the in-app notification (log-and-continue, no
 * silent total failure — see docs/specs/installable-plugins/specs/2026-06-06-installable-plugins-mcp-design.md §7).
 */
export async function notifyOrgManagers(
  input: NotifyOrgManagersInput,
): Promise<void> {
  const {
    orgId,
    workspaceId,
    kind,
    title,
    body,
    deepLink,
    emailHtml,
    _recipientsOverride,
  } = input;

  // ── 1. Resolve recipients ──────────────────────────────────────────────────
  let recipients: NotificationRecipient[];
  let emailDisabled = input.emailDisabled;

  if (_recipientsOverride !== undefined) {
    // Unit-test path: skip DB queries.
    recipients = _recipientsOverride;
  } else {
    // Production path: read org settings, resolve org_users, resolve emails.
    const { alertRoles, sendEmailEnabled } = await withSystemDb(async (tx) => {
      const [orgRow] = await tx
        .select({ settings: schema.organizations.settings })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, orgId))
        .limit(1);

      const rawSettings = (orgRow?.settings ?? {}) as Record<string, unknown>;
      const alertSettings = (rawSettings["mcp_auth_alerts"] ??
        {}) as McpAuthAlertsSetting;
      const roles: string[] =
        Array.isArray(alertSettings.roles) && alertSettings.roles.length > 0
          ? alertSettings.roles
          : (DEFAULT_ALERT_ROLES as unknown as string[]);
      const sendEmailFlag =
        typeof alertSettings.send_email === "boolean"
          ? alertSettings.send_email
          : true;
      return { alertRoles: roles, sendEmailEnabled: sendEmailFlag };
    });

    // Resolve org_users whose role is in alertRoles.
    const userIds = await withSystemDb(async (tx) => {
      const rows = await tx
        .select({ userId: schema.orgUsers.userId })
        .from(schema.orgUsers)
        .where(
          and(
            eq(schema.orgUsers.orgId, orgId),
            inArray(schema.orgUsers.role, alertRoles),
          ),
        );
      return rows.map((r) => r.userId);
    });

    if (userIds.length === 0) {
      logger.warn(
        { orgId },
        "[notifyOrgManagers] no recipients resolved; skipping",
      );
      return;
    }

    // Resolve email addresses for the resolved user ids.
    const userRows = await withSystemDb(async (tx) =>
      tx
        .select({ id: schema.users.id, email: schema.users.email })
        .from(schema.users)
        .where(inArray(schema.users.id, userIds)),
    );

    recipients = userRows.map((u) => ({ userId: u.id, email: u.email }));

    // Apply settings-derived email flag if caller didn't set it.
    if (emailDisabled === undefined) {
      emailDisabled = !sendEmailEnabled;
    }
  }

  // ── 2. Notify each recipient ───────────────────────────────────────────────
  for (const recipient of recipients) {
    // Always create the in-app notification first.
    let notificationId: string | null = null;
    try {
      const notif = await createNotification({
        orgId,
        workspaceId,
        userId: recipient.userId,
        kind,
        title,
        body,
        deepLink,
      });
      notificationId = notif.id;
    } catch (err) {
      logger.error(
        { orgId, userId: recipient.userId, err },
        "[notifyOrgManagers] failed to create in-app notification",
      );
      // In-app failure is logged; continue to the next recipient so one bad
      // row doesn't block notifying the rest.
      continue;
    }

    // Send email if not disabled.
    if (!emailDisabled) {
      try {
        await sendEmail({
          to: recipient.email,
          subject: title,
          text: body ?? title,
          html: emailHtml,
        });

        // Stamp emailedAt on the notification row.
        await withSystemDb(async (tx) => {
          await tx
            .update(schema.notifications)
            .set({ emailedAt: new Date() })
            .where(eq(schema.notifications.id, notificationId!));
        });
      } catch (err) {
        // Log but do NOT re-throw — in-app notification already created.
        logger.error(
          { orgId, userId: recipient.userId, email: recipient.email, err },
          "[notifyOrgManagers] email send failed (in-app notification still created)",
        );
      }
    }
  }
}
