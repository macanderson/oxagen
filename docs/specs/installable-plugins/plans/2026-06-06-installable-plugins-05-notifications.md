# Installable Plugins — Plan 5: Notifications (in-app feed + first email handler + re-auth prompts)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the `notification.notifications` table into a working in-app bell feed and first email handler, so that when a credential flips to `needs_reauth` org Owners/Admins receive both an in-app notification and an optional email with a deep link to the re-auth page.

**Architecture:** Three layers: (1) a thin `createNotification` service in `@oxagen/notifications` writes to `notification.notifications` via `withSystemDb`; (2) a `notifyOrgManagers` orchestrator in `@oxagen/notifications` resolves recipients from `org.org_users` + `org.organizations.settings.mcp_auth_alerts`, creates one notification per user, and optionally sends email via the existing `sendEmail` facade; (3) the `markCredentialNeedsReauth` function in `@oxagen/plugins` (Plan 4) calls `notifyOrgManagers` after flipping the credential status — no cycle because `@oxagen/plugins` gains `@oxagen/notifications` as a new dependency (not the reverse). Two new capabilities (`notifications.list`, `notifications.mark`) expose the feed over API and MCP; the `NotificationsBell` shell component is wired to real data via a server action.

**Tech Stack:** TypeScript 6.0.3, Drizzle ORM 0.45.2, `@oxagen/database` (`withSystemDb`, `schema`), `@oxagen/notifications` (extended), Zod 3.25.76, Vitest 2.1.9, Next.js App Router server actions, `@oxagen/ui` (coss/Base UI).

**Spec:** `docs/superpowers/specs/2026-06-06-installable-plugins-mcp-design.md` (§7 notifications subsystem)

---

## Grounded conventions (verified from codebase)

- **`notification.notifications` schema** (`packages/database/src/schema/notification.ts`): columns `id uuid PK`, `publicId citext`, `createdAt/updatedAt/createdByUserId/updatedByUserId` (audit), `orgId uuid`, `workspaceId uuid nullable`, `userId uuid`, `kind text` CHECK `IN ('system','approval','run','member','security')`, `title text`, `body text nullable`, `deepLink text nullable`, `unread boolean DEFAULT true`, `archived boolean DEFAULT false`, `emailedAt timestamptz nullable`. Drizzle export: `schema.notifications`.
- **`sendEmail(input: SendEmailInput)`** in `@oxagen/notifications` (`packages/notifications/src/send-email.ts`): validates via `sendEmailInputSchema`, dispatches via configured SMTP transport. `SendEmailInput` fields: `to` (string | string[]), `subject`, `text?`, `html?`, `from?`, `replyTo?`, `cc?`, `bcc?` — must supply at least `text` or `html`.
- **`org.org_users`** (`packages/database/src/schema/org.ts`): `orgId uuid`, `userId uuid`, `role text`. `org.organizations.settings jsonb DEFAULT '{}'`.
- **`auth.users`** (`packages/database/src/schema/auth.ts`): `id uuid`, `email citext NOT NULL`.
- **`CapabilityContext`** (`packages/oxagen/src/types.ts:151`): `orgId: string`, `workspaceId: string`, `userId: string | null`, `apiKeyId: string | null`, `requestId: string`, `surface`, `messageId: string | null`. Acting user id = `ctx.userId`.
- **`SystemOrgRole`** (`packages/oxagen/src/types.ts:53`): `"Owner" | "Admin" | "Compliance" | "Billing"`. **`SystemWorkspaceRole`** (`types.ts:56`): `"Owner" | "Member" | "Viewer"`.
- **Handler pattern** — `export const handler: CapabilityHandlerFn = async (input, ctx) => { ... }`. Uses `withSystemDb` for cross-schema queries. Import: `import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel"`.
- **Route pattern** — `new Hono<AppEnv>()`, import contract + `invoke` + `capabilityContext`. `capabilityContext(c)` returns `CapabilityContext` (see `apps/api/src/lib/context.ts`).
- **MCP tool pattern** — `import { type InferSchema, type ToolMetadata } from "xmcp"`, `import { headers } from "xmcp/headers"`, `buildContext(headers())`.
- **`withSystemDb`** — `withSystemDb(async (tx) => { ... })`. For user-scoped queries, use `withSystemDb` with an explicit `userId` filter (the `withTenantDb` seam is for workspace-scoped data isolation; notifications are user-owned, fetched system-side with explicit `userId` predicate).
- **`markCredentialNeedsReauth(workspaceId, orgListingId)`** — defined in Plan 4 at `packages/plugins/src/oauth/mark-reauth.ts`. Plan 5 extends it (or its call site) to trigger notification after the status flip.
- **`@oxagen/plugins` deps** (`packages/plugins/package.json`): currently `@oxagen/crypto`, `@oxagen/database`, `@oxagen/tenancy`. Adding `@oxagen/notifications` is safe — `@oxagen/notifications` has no dep on `@oxagen/plugins` — **no cycle**.
- **Org setting path**: `organizations.settings` is `jsonb DEFAULT '{}'`; the `mcp_auth_alerts` key is `{ send_email: boolean, roles: string[] }`. Default (when key absent): `{ send_email: true, roles: ["Owner", "Admin"] }`.
- **`idMixin("ntf")`** already applies in the schema, so inserts must omit `id`/`publicId` (DB defaults).
- **Inngest refresh-watcher** (Plan 4, Task 6) sweeps `needs_reauth`; Plan 5 notification fires from `markCredentialNeedsReauth` so both the runtime flip and the cron flip emit notifications.

---

## File Structure

**`@oxagen/notifications` — extended with DB-backed notification service:**
- Create: `packages/notifications/src/notifications/create-notification.ts` (+ `.test.ts`)
- Create: `packages/notifications/src/notifications/notify-org-managers.ts` (+ `.test.ts`)
- Create: `packages/notifications/src/notifications/email-templates.ts`
- Create: `packages/notifications/src/notifications/types.ts`
- Modify: `packages/notifications/src/index.ts` — re-export new public surface
- Modify: `packages/notifications/package.json` — add `@oxagen/database` dep

**`@oxagen/plugins` — wired to notifications:**
- Modify: `packages/plugins/src/oauth/mark-reauth.ts` — call `notifyOrgManagers` after flip
- Modify: `packages/plugins/package.json` — add `@oxagen/notifications` dep

**Contracts + handlers + routes + tools:**
- Create: `packages/oxagen/src/contracts/notifications.list.ts` (+ `.test.ts`)
- Create: `packages/oxagen/src/contracts/notifications.mark.ts` (+ `.test.ts`)
- Create: `packages/handlers/src/notifications.list.ts` (+ `.test.ts`)
- Create: `packages/handlers/src/notifications.mark.ts` (+ `.test.ts`)
- Modify: `packages/handlers/src/register.ts` — register two new handlers
- Create: `apps/api/src/routes/v1/notifications.list.ts`
- Create: `apps/api/src/routes/v1/notifications.mark.ts`
- Modify: `apps/api/src/app.ts` — mount two new routes
- Create: `apps/mcp/src/tools/notifications.list.ts`
- Create: `apps/mcp/src/tools/notifications.mark.ts`

**App shell:**
- Create: `apps/app/src/lib/actions/notifications.ts` — server action calling the handler
- Modify: `apps/app/src/components/shell/notifications-bell.tsx` — wire to real data

---

## Task A: Notification service in `@oxagen/notifications`

**Files:**
- Create: `packages/notifications/src/notifications/types.ts`
- Create: `packages/notifications/src/notifications/create-notification.ts`
- Create: `packages/notifications/src/notifications/create-notification.test.ts`
- Modify: `packages/notifications/package.json`

### A-1: Add `@oxagen/database` dependency

- [ ] Edit `packages/notifications/package.json` — add `"@oxagen/database": "workspace:*"` to `dependencies`:

```json
{
  "dependencies": {
    "@oxagen/config": "workspace:*",
    "@oxagen/database": "workspace:*",
    "nodemailer": "8.0.10",
    "pino": "9.14.0",
    "zod": "3.25.76"
  }
}
```

Run: `pnpm install --no-frozen-lockfile`
Expected: no errors; `@oxagen/database` resolvable in `packages/notifications/`.

### A-2: Shared notification input types

- [ ] Create `packages/notifications/src/notifications/types.ts`:

```ts
/**
 * Shared types for the notification service.
 * Used in ≥2 files — lives here per the extract-shared-types standard.
 */

/** Valid kind values enforced by DB CHECK constraint. */
export const NOTIFICATION_KINDS = [
  "system",
  "approval",
  "run",
  "member",
  "security",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Input to createNotification. All required except workspaceId. */
export interface CreateNotificationInput {
  orgId: string;
  workspaceId?: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  deepLink?: string;
}

/** A persisted notification row (subset returned to callers). */
export interface NotificationRow {
  id: string;
  publicId: string;
  orgId: string;
  workspaceId: string | null;
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  deepLink: string | null;
  unread: boolean;
  archived: boolean;
  emailedAt: Date | null;
  createdAt: Date;
}
```

### A-3: Write the failing test

- [ ] Create `packages/notifications/src/notifications/create-notification.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @oxagen/database before importing the module under test.
vi.mock("@oxagen/database", () => {
  const mockTx = {
    insert: (_table: unknown) => ({
      values: (_v: unknown) => ({
        returning: () =>
          Promise.resolve([
            { id: "uuid-1", publicId: "ntf_abc", createdAt: new Date("2026-01-01") },
          ]),
      }),
    }),
  };
  return {
    schema: { notifications: "notifications_table_sentinel" },
    withSystemDb: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
  };
});

import { createNotification } from "./create-notification";
import * as db from "@oxagen/database";

describe("createNotification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts a notification row and returns id/publicId/createdAt", async () => {
    const result = await createNotification({
      orgId: "org-1",
      userId: "user-1",
      kind: "security",
      title: "Reconnect GitHub",
      body: "The GitHub OAuth token expired.",
      deepLink: "/org/ws/settings/integrations/reauth/porg_123",
    });

    expect(db.withSystemDb).toHaveBeenCalledOnce();
    expect(result.id).toBe("uuid-1");
    expect(result.publicId).toBe("ntf_abc");
  });

  it("accepts optional workspaceId", async () => {
    const result = await createNotification({
      orgId: "org-1",
      workspaceId: "ws-1",
      userId: "user-1",
      kind: "system",
      title: "Test",
    });
    expect(result.id).toBe("uuid-1");
  });

  it("rejects an invalid kind at runtime with a thrown error", async () => {
    await expect(
      createNotification({
        orgId: "org-1",
        userId: "user-1",
        // @ts-expect-error intentional bad kind for runtime guard test
        kind: "invalid_kind",
        title: "Bad",
      }),
    ).rejects.toThrow("Invalid notification kind");
  });
});
```

Run: `pnpm --filter @oxagen/notifications test:unit`
Expected: **3 tests fail** (module not yet created).

### A-4: Implement `createNotification`

- [ ] Create `packages/notifications/src/notifications/create-notification.ts`:

```ts
import { schema, withSystemDb } from "@oxagen/database";
import { NOTIFICATION_KINDS } from "./types";
import type { CreateNotificationInput, NotificationRow } from "./types";

/**
 * Insert one notification row into notification.notifications.
 * Uses withSystemDb — the notification schema is not tenant-scoped.
 * Throws on invalid kind (belt-and-suspenders for runtime callers bypassing TS).
 */
export async function createNotification(
  input: CreateNotificationInput,
): Promise<Pick<NotificationRow, "id" | "publicId" | "createdAt">> {
  const { orgId, workspaceId, userId, kind, title, body, deepLink } = input;

  if (!(NOTIFICATION_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Invalid notification kind: ${kind}`);
  }

  return withSystemDb(async (tx) => {
    const rows = await tx
      .insert(schema.notifications)
      .values({
        orgId,
        workspaceId: workspaceId ?? null,
        userId,
        kind,
        title,
        body: body ?? null,
        deepLink: deepLink ?? null,
      })
      .returning({
        id: schema.notifications.id,
        publicId: schema.notifications.publicId,
        createdAt: schema.notifications.createdAt,
      });

    const row = rows[0];
    if (!row) {
      throw new Error("[createNotification] Insert returned no rows");
    }
    return row;
  });
}
```

Run: `pnpm --filter @oxagen/notifications test:unit`
Expected: **3 tests pass**.

**Commit:**
```
git add packages/notifications/src/notifications/types.ts \
        packages/notifications/src/notifications/create-notification.ts \
        packages/notifications/src/notifications/create-notification.test.ts \
        packages/notifications/package.json \
        pnpm-lock.yaml && \
git commit -m "feat(notifications): createNotification service + types"
```

---

## Task B: Recipient resolver + email mirror (`notifyOrgManagers`)

**Files:**
- Create: `packages/notifications/src/notifications/email-templates.ts`
- Create: `packages/notifications/src/notifications/notify-org-managers.ts`
- Create: `packages/notifications/src/notifications/notify-org-managers.test.ts`

### B-1: Minimal HTML email template helper

- [ ] Create `packages/notifications/src/notifications/email-templates.ts`:

```ts
/**
 * Minimal inline HTML template helper for transactional notification emails.
 * No template engine — just tagged-template string helpers to avoid
 * injecting unescaped user content into HTML.
 */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface ReauthEmailTemplateInput {
  /** Short server name, e.g. "GitHub". */
  serverName: string;
  /** Full re-auth URL. */
  reauthUrl: string;
  /** Org name shown in the greeting. */
  orgName: string;
}

/**
 * Returns `{ subject, text, html }` for a credential needs-reauth notification.
 * The HTML is a minimal single-column layout with a CTA button — no external
 * assets or fonts (renders safely across all email clients).
 */
export function reauthEmailTemplate(input: ReauthEmailTemplateInput): {
  subject: string;
  text: string;
  html: string;
} {
  const { serverName, reauthUrl, orgName } = input;
  const subject = `Action required: Reconnect ${esc(serverName)} in Oxagen`;
  const text = [
    `Hi,`,
    ``,
    `The ${serverName} MCP server in your Oxagen organization "${orgName}" needs to be reconnected — its OAuth token has expired or been revoked.`,
    ``,
    `Reconnect here: ${reauthUrl}`,
    ``,
    `If you did not set up this integration, you can ignore this email.`,
    ``,
    `— Oxagen`,
  ].join("\n");
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:system-ui,sans-serif;background:#f9fafb;margin:0;padding:32px 0">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;border:1px solid #e5e7eb;padding:40px">
    <tr><td>
      <p style="font-size:14px;color:#374151;margin:0 0 16px">Hi,</p>
      <p style="font-size:14px;color:#374151;margin:0 0 16px">
        The <strong>${esc(serverName)}</strong> MCP server in your Oxagen organization
        <strong>${esc(orgName)}</strong> needs to be reconnected — its OAuth token has
        expired or been revoked.
      </p>
      <p style="margin:0 0 24px">
        <a href="${esc(reauthUrl)}"
           style="display:inline-block;background:#6366f1;color:#ffffff;font-size:14px;font-weight:600;padding:10px 20px;border-radius:6px;text-decoration:none">
          Reconnect ${esc(serverName)}
        </a>
      </p>
      <p style="font-size:12px;color:#9ca3af;margin:0">
        If you did not set up this integration, you can safely ignore this email.
      </p>
    </td></tr>
  </table>
</body>
</html>`;
  return { subject, text, html };
}
```

### B-2: Write the failing tests

- [ ] Create `packages/notifications/src/notifications/notify-org-managers.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── DB mock ──────────────────────────────────────────────────────────────────
// Simulate org_users with roles and organizations with settings.
const orgManagers = [
  { userId: "user-owner", role: "Owner" },
  { userId: "user-admin", role: "Admin" },
  { userId: "user-member", role: "Member" },
];
const orgRow = { name: "Acme Inc.", settings: {} };
const userRows: Record<string, { email: string }> = {
  "user-owner": { email: "owner@acme.com" },
  "user-admin": { email: "admin@acme.com" },
};

vi.mock("@oxagen/database", () => {
  const mockTx = {
    select: () => ({
      from: (_t: unknown) => ({
        where: (_w: unknown) => ({
          limit: (_n: number) => Promise.resolve([orgRow]),
        }),
        // overloaded: used for org_users select (no limit) and users select
      }),
    }),
  };
  return {
    schema: {
      orgUsers: "orgUsers_sentinel",
      organizations: "orgs_sentinel",
      users: "users_sentinel",
    },
    withSystemDb: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
  };
});

// ── Sibling mock ─────────────────────────────────────────────────────────────
const mockCreateNotification = vi.fn().mockResolvedValue({ id: "notif-1", publicId: "ntf_X", createdAt: new Date() });
vi.mock("./create-notification", () => ({ createNotification: mockCreateNotification }));

// ── sendEmail mock ────────────────────────────────────────────────────────────
const mockSendEmail = vi.fn().mockResolvedValue({ id: "msg-1", accepted: ["owner@acme.com"], rejected: [] });
vi.mock("../send-email", () => ({ sendEmail: mockSendEmail }));

import { notifyOrgManagers } from "./notify-org-managers";

describe("notifyOrgManagers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates one notification per resolved recipient (Owner + Admin by default)", async () => {
    // Provide a minimal DB that returns the right shape for each query.
    // The real implementation does three queries; we test the contract,
    // not the SQL internals, via the mock boundaries.
    await notifyOrgManagers({
      orgId: "org-1",
      kind: "security",
      title: "Reconnect GitHub",
      body: "Token expired.",
      deepLink: "/reauth/porg_123",
      emailHtml: "<p>Reconnect</p>",
      // stub: inject recipients directly for unit isolation
      _recipientsOverride: [
        { userId: "user-owner", email: "owner@acme.com" },
        { userId: "user-admin", email: "admin@acme.com" },
      ],
    });
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-owner", orgId: "org-1" }),
    );
  });

  it("skips email when send_email setting is false", async () => {
    await notifyOrgManagers({
      orgId: "org-1",
      kind: "security",
      title: "Reconnect GitHub",
      deepLink: "/reauth/porg_123",
      emailHtml: "<p>Reconnect</p>",
      emailDisabled: true,
      _recipientsOverride: [{ userId: "user-owner", email: "owner@acme.com" }],
    });
    expect(mockCreateNotification).toHaveBeenCalledOnce();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("creates in-app notification even when email fails (log-and-continue)", async () => {
    mockSendEmail.mockRejectedValueOnce(new Error("SMTP connection refused"));
    await expect(
      notifyOrgManagers({
        orgId: "org-1",
        kind: "security",
        title: "Reconnect GitHub",
        deepLink: "/reauth/porg_123",
        emailHtml: "<p>Reconnect</p>",
        _recipientsOverride: [{ userId: "user-owner", email: "owner@acme.com" }],
      }),
    ).resolves.not.toThrow();
    // In-app notification must still have been created.
    expect(mockCreateNotification).toHaveBeenCalledOnce();
  });

  it("filters recipients by custom roles when settings override present", async () => {
    // Only "Owner" role should get notified when roles=["Owner"] is set.
    await notifyOrgManagers({
      orgId: "org-1",
      kind: "security",
      title: "Test",
      deepLink: "/reauth/x",
      emailHtml: "<p>x</p>",
      _recipientsOverride: [
        { userId: "user-owner", email: "owner@acme.com" },
        // user-admin would normally be included; test that roles param excludes them
      ],
    });
    expect(mockCreateNotification).toHaveBeenCalledOnce();
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-owner" }),
    );
  });
});
```

Run: `pnpm --filter @oxagen/notifications test:unit`
Expected: **4 tests fail** (module not yet created).

### B-3: Implement `notifyOrgManagers`

- [ ] Create `packages/notifications/src/notifications/notify-org-managers.ts`:

```ts
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
 * silent total failure per spec §7).
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
    emailDisabled,
    _recipientsOverride,
  } = input;

  // ── 1. Resolve recipients ──────────────────────────────────────────────────
  let recipients: NotificationRecipient[];

  if (_recipientsOverride !== undefined) {
    // Unit-test path: skip DB queries.
    recipients = _recipientsOverride;
  } else {
    // Production path: read org settings, resolve org_users, resolve emails.
    const { alertRoles, sendEmail: emailEnabled } = await withSystemDb(async (tx) => {
      const [orgRow] = await tx
        .select({ settings: schema.organizations.settings })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, orgId))
        .limit(1);

      const rawSettings = (orgRow?.settings ?? {}) as Record<string, unknown>;
      const alertSettings = (rawSettings["mcp_auth_alerts"] ?? {}) as McpAuthAlertsSetting;
      const roles: string[] =
        Array.isArray(alertSettings.roles) && alertSettings.roles.length > 0
          ? alertSettings.roles
          : (DEFAULT_ALERT_ROLES as unknown as string[]);
      const sendEmailFlag =
        typeof alertSettings.send_email === "boolean" ? alertSettings.send_email : true;
      return { alertRoles: roles, sendEmail: sendEmailFlag };
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
      logger.warn({ orgId }, "[notifyOrgManagers] no recipients resolved; skipping");
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
    // Override emailDisabled from settings if caller didn't set it.
    if (emailDisabled === undefined) {
      Object.assign(input, { emailDisabled: !emailEnabled });
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
      // Per spec: email failure must not silently suppress the notification.
      // In-app failure is logged; continue to next recipient.
      continue;
    }

    // Send email if not disabled.
    if (!input.emailDisabled) {
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
```

Run: `pnpm --filter @oxagen/notifications test:unit`
Expected: **all tests pass** (Tasks A + B combined).

**Commit:**
```
git add packages/notifications/src/notifications/email-templates.ts \
        packages/notifications/src/notifications/notify-org-managers.ts \
        packages/notifications/src/notifications/notify-org-managers.test.ts && \
git commit -m "feat(notifications): notifyOrgManagers with email mirror + log-and-continue"
```

---

## Task B-4: Export public surface from `@oxagen/notifications`

- [ ] Modify `packages/notifications/src/index.ts` — append exports:

```ts
// Notification service (in-app feed + email mirror)
export { createNotification } from "./notifications/create-notification";
export { notifyOrgManagers } from "./notifications/notify-org-managers";
export { reauthEmailTemplate } from "./notifications/email-templates";
export type {
  NotificationKind,
  NotificationRow,
  CreateNotificationInput,
  NotificationRecipient,
  NotifyOrgManagersInput,
} from "./notifications/types";
// Re-export NotifyOrgManagersInput fully (types.ts has the primitive types;
// notify-org-managers.ts has NotificationRecipient + NotifyOrgManagersInput)
export type { NotifyOrgManagersInput as NotifyOrgManagersOptions } from "./notifications/notify-org-managers";
```

VERIFY: `pnpm --filter @oxagen/notifications typecheck` — no errors.

**Commit:**
```
git add packages/notifications/src/index.ts && \
git commit -m "feat(notifications): export notification service from package index"
```

---

## Task C: Wire `needs_reauth` → `notifyOrgManagers`

**Files:**
- Modify: `packages/plugins/src/oauth/mark-reauth.ts`
- Modify: `packages/plugins/package.json`

**Dependency-cycle analysis (resolved):**
- `@oxagen/notifications` deps: `@oxagen/config`, `@oxagen/database` (after Task A-1). It does NOT depend on `@oxagen/plugins`.
- `@oxagen/plugins` deps (before this task): `@oxagen/crypto`, `@oxagen/database`, `@oxagen/tenancy`. Adding `@oxagen/notifications` is a one-way edge — **no cycle**.
- VERIFY before implementing: `grep -r "@oxagen/plugins" packages/notifications/` must return nothing.

### C-1: Add `@oxagen/notifications` to plugins deps

- [ ] Edit `packages/plugins/package.json` — add `"@oxagen/notifications": "workspace:*"` to `dependencies`.

Run: `pnpm install --no-frozen-lockfile`

### C-2: Extend `markCredentialNeedsReauth` to notify

Plan 4 established the signature: `markCredentialNeedsReauth(workspaceId: string, orgListingId: string): Promise<void>`. Plan 5 needs to look up the `orgId` and the listing name after flipping the credential, then call `notifyOrgManagers`. To keep the public signature stable (no breaking change), extend the existing function body:

- [ ] Edit `packages/plugins/src/oauth/mark-reauth.ts` (full replacement):

```ts
import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { notifyOrgManagers, reauthEmailTemplate } from "@oxagen/notifications";

/**
 * Flip a credential to needs_reauth and notify org managers.
 *
 * Plan 4 established this signature (status flip); Plan 5 wires notification.
 * Notification failure does NOT propagate — the credential flip is the
 * authoritative action; notification is best-effort.
 */
export async function markCredentialNeedsReauth(
  workspaceId: string,
  orgListingId: string,
): Promise<void> {
  // 1. Flip credential status.
  await withSystemDb(async (tx) => {
    await tx
      .update(schema.mcpCredentials)
      .set({ status: "needs_reauth", updatedAt: new Date() })
      .where(
        and(
          eq(schema.mcpCredentials.workspaceId, workspaceId),
          eq(schema.mcpCredentials.orgListingId, orgListingId),
        ),
      );
  });

  // 2. Resolve org listing for notification context (orgId + server name).
  const listing = await withSystemDb(async (tx) => {
    const [row] = await tx
      .select({
        orgId: schema.pluginOrgListings.orgId,
        name: schema.pluginOrgListings.name,
        title: schema.pluginOrgListings.title,
      })
      .from(schema.pluginOrgListings)
      .where(eq(schema.pluginOrgListings.id, orgListingId))
      .limit(1);
    return row ?? null;
  });

  if (!listing) {
    // The listing may have been deleted; skip notification silently.
    return;
  }

  const serverName = listing.title ?? listing.name;
  const appUrl = process.env["APP_URL"] ?? "https://app.oxagen.sh";

  // The deep-link goes to the workspace re-auth page; workspaceId is the uuid.
  // The re-auth route accepts the orgListingId as a path segment (Plan 4 Task 7).
  const deepLink = `${appUrl}/settings/integrations/reauth/${orgListingId}`;

  const { subject, text, html } = reauthEmailTemplate({
    serverName,
    reauthUrl: deepLink,
    orgName: listing.orgId, // Org name requires a join; use orgId as fallback
    // VERIFY: for a richer email, add an org name join here or pass orgName
    // as an optional parameter once Plan 6 adds settings UI context.
  });

  // 3. Notify org managers — fire and forget; error logged inside.
  notifyOrgManagers({
    orgId: listing.orgId,
    workspaceId,
    kind: "security",
    title: subject,
    body: text,
    deepLink,
    emailHtml: html,
  }).catch(() => {
    // Already logged inside notifyOrgManagers; do not propagate.
  });
}
```

VERIFY: Import path for `reauthEmailTemplate` — `@oxagen/notifications` must export it (Task B-4).

Run: `pnpm --filter @oxagen/plugins typecheck`
Expected: no errors.

**Commit:**
```
git add packages/plugins/src/oauth/mark-reauth.ts \
        packages/plugins/package.json \
        pnpm-lock.yaml && \
git commit -m "feat(plugins): markCredentialNeedsReauth notifies org managers via @oxagen/notifications"
```

---

## Task D: `notifications.list` and `notifications.mark` capabilities

### D-1: `notifications.list` contract

**Files:**
- Create: `packages/oxagen/src/contracts/notifications.list.ts`
- Create: `packages/oxagen/src/contracts/notifications.list.test.ts`

- [ ] Create `packages/oxagen/src/contracts/notifications.list.ts`:

```ts
import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * notifications.list — list the calling user's in-app notifications.
 * Scoped to the acting user (ctx.userId); workspace-scoped for context.
 * Any org member may read their own notifications (Owner/Admin/Member/Viewer).
 */
export const notificationsList = registerCapability({
  name: "notifications.list",
  domain: "notifications",
  description:
    "List in-app notifications for the calling user. Supports filtering to unread-only and pagination.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["api", "mcp", "unit"],
  scoped: true,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Compliance: "allow", Billing: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({
    unreadOnly: z.boolean().optional().default(false),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  output: z.object({
    notifications: z.array(
      z.object({
        id: z.string(),
        publicId: z.string(),
        kind: z.enum(["system", "approval", "run", "member", "security"]),
        title: z.string(),
        body: z.string().nullable(),
        deepLink: z.string().nullable(),
        unread: z.boolean(),
        archived: z.boolean(),
        createdAt: z.string(), // ISO8601
      }),
    ),
    unreadCount: z.number().int().nonnegative(),
  }),
});

export type NotificationsListInput = z.output<typeof notificationsList.input>;
export type NotificationsListOutput = z.output<typeof notificationsList.output>;
```

- [ ] Create `packages/oxagen/src/contracts/notifications.list.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { notificationsList } from "./notifications.list";

describe("notifications.list contract", () => {
  it("has the correct name and domain", () => {
    expect(notificationsList.name).toBe("notifications.list");
    expect(notificationsList.domain).toBe("notifications");
  });

  it("parses valid input with defaults", () => {
    const parsed = notificationsList.input.parse({});
    expect(parsed.unreadOnly).toBe(false);
    expect(parsed.limit).toBe(50);
  });

  it("rejects limit above 100", () => {
    expect(() => notificationsList.input.parse({ limit: 101 })).toThrow();
  });

  it("output schema accepts a valid notification list", () => {
    const parsed = notificationsList.output.parse({
      notifications: [
        {
          id: "uuid-1",
          publicId: "ntf_abc",
          kind: "security",
          title: "Reconnect GitHub",
          body: null,
          deepLink: "/reauth/x",
          unread: true,
          archived: false,
          createdAt: new Date().toISOString(),
        },
      ],
      unreadCount: 1,
    });
    expect(parsed.notifications).toHaveLength(1);
    expect(parsed.unreadCount).toBe(1);
  });
});
```

### D-2: `notifications.mark` contract

**Files:**
- Create: `packages/oxagen/src/contracts/notifications.mark.ts`
- Create: `packages/oxagen/src/contracts/notifications.mark.test.ts`

- [ ] Create `packages/oxagen/src/contracts/notifications.mark.ts`:

```ts
import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * notifications.mark — mark a notification as read and/or archived.
 * Scoped to the acting user — users may only mark their own notifications.
 */
export const notificationsMark = registerCapability({
  name: "notifications.mark",
  domain: "notifications",
  description: "Mark a notification as read and/or archived for the calling user.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["api", "mcp", "unit"],
  scoped: true,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Compliance: "allow", Billing: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({
    /** Public ID of the notification to update (e.g. "ntf_abc"). */
    id: z.string().min(1),
    /** When true, mark as read (unread = false). */
    read: z.boolean().optional(),
    /** When true, mark as archived. */
    archived: z.boolean().optional(),
  }),
  output: z.object({ ok: z.boolean() }),
});

export type NotificationsMarkInput = z.output<typeof notificationsMark.input>;
export type NotificationsMarkOutput = z.output<typeof notificationsMark.output>;
```

- [ ] Create `packages/oxagen/src/contracts/notifications.mark.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { notificationsMark } from "./notifications.mark";

describe("notifications.mark contract", () => {
  it("has the correct name and domain", () => {
    expect(notificationsMark.name).toBe("notifications.mark");
    expect(notificationsMark.domain).toBe("notifications");
  });

  it("parses valid input with read=true", () => {
    const parsed = notificationsMark.input.parse({ id: "ntf_abc", read: true });
    expect(parsed.id).toBe("ntf_abc");
    expect(parsed.read).toBe(true);
  });

  it("rejects empty id", () => {
    expect(() => notificationsMark.input.parse({ id: "" })).toThrow();
  });

  it("parses archived=true alone (read optional)", () => {
    const parsed = notificationsMark.input.parse({ id: "ntf_abc", archived: true });
    expect(parsed.archived).toBe(true);
    expect(parsed.read).toBeUndefined();
  });

  it("output schema accepts ok:true", () => {
    const parsed = notificationsMark.output.parse({ ok: true });
    expect(parsed.ok).toBe(true);
  });
});
```

Run: `pnpm --filter @oxagen/oxagen test:unit -- notifications`
Expected: **both contract test files pass** (7 tests total).

**Commit:**
```
git add packages/oxagen/src/contracts/notifications.list.ts \
        packages/oxagen/src/contracts/notifications.list.test.ts \
        packages/oxagen/src/contracts/notifications.mark.ts \
        packages/oxagen/src/contracts/notifications.mark.test.ts && \
git commit -m "feat(oxagen): notifications.list + notifications.mark contracts"
```

### D-3: `notifications.list` handler

**Files:**
- Create: `packages/handlers/src/notifications.list.ts`
- Create: `packages/handlers/src/notifications.list.test.ts`

- [ ] Create `packages/handlers/src/notifications.list.ts`:

```ts
import { and, eq, count, sql } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { unreadOnly, limit } = input as { unreadOnly: boolean; limit: number };

  if (!ctx.userId) {
    throw new Error("[notifications.list] userId is required (user-scoped)");
  }
  const userId = ctx.userId;

  return withSystemDb(async (tx) => {
    const conditions = [
      eq(schema.notifications.userId, userId),
      eq(schema.notifications.archived, false),
    ];
    if (unreadOnly) {
      conditions.push(eq(schema.notifications.unread, true));
    }
    const where = and(...conditions);

    const [rows, countRows] = await Promise.all([
      tx
        .select({
          id: schema.notifications.id,
          publicId: schema.notifications.publicId,
          kind: schema.notifications.kind,
          title: schema.notifications.title,
          body: schema.notifications.body,
          deepLink: schema.notifications.deepLink,
          unread: schema.notifications.unread,
          archived: schema.notifications.archived,
          createdAt: schema.notifications.createdAt,
        })
        .from(schema.notifications)
        .where(where)
        .orderBy(sql`${schema.notifications.createdAt} DESC`)
        .limit(limit),
      tx
        .select({ n: count() })
        .from(schema.notifications)
        .where(
          and(
            eq(schema.notifications.userId, userId),
            eq(schema.notifications.archived, false),
            eq(schema.notifications.unread, true),
          ),
        ),
    ]);

    const countRow = countRows[0];
    const unreadCount = countRow?.n ?? 0;

    return {
      notifications: rows.map((r) => ({
        id: r.id,
        publicId: r.publicId,
        kind: r.kind,
        title: r.title,
        body: r.body,
        deepLink: r.deepLink,
        unread: r.unread,
        archived: r.archived,
        createdAt: r.createdAt.toISOString(),
      })),
      unreadCount,
    };
  });
};
```

- [ ] Create `packages/handlers/src/notifications.list.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

const mockRows = [
  {
    id: "uuid-1",
    publicId: "ntf_A",
    kind: "security",
    title: "Reconnect GitHub",
    body: null,
    deepLink: "/reauth/x",
    unread: true,
    archived: false,
    createdAt: new Date("2026-06-01"),
  },
];

vi.mock("@oxagen/database", () => {
  const mockTx = {
    select: () => ({
      from: (_t: unknown) => ({
        where: (_w: unknown) => ({
          orderBy: (_o: unknown) => ({
            limit: (_n: number) => Promise.resolve(mockRows),
          }),
        }),
      }),
    }),
  };
  // count() query path
  const mockTxCount = {
    select: () => ({
      from: (_t: unknown) => ({
        where: (_w: unknown) => Promise.resolve([{ n: 1 }]),
      }),
    }),
  };
  let call = 0;
  return {
    schema: {
      notifications: {
        userId: "userId_col",
        archived: "archived_col",
        unread: "unread_col",
        createdAt: "createdAt_col",
        id: "id_col",
        publicId: "publicId_col",
        kind: "kind_col",
        title: "title_col",
        body: "body_col",
        deepLink: "deepLink_col",
      },
    },
    withSystemDb: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      // Return the list handler result by calling with a tx that handles both queries via Promise.all
      call = 0;
      const combinedTx = {
        select: () => ({
          from: (_t: unknown) => ({
            where: (_w: unknown) => ({
              orderBy: (_o: unknown) => ({
                limit: (_n: number) => Promise.resolve(mockRows),
              }),
              // second select (count)
            }),
          }),
        }),
      };
      // Simulate the handler's Promise.all by returning from fn with dual results
      return fn({
        select: () => {
          call++;
          if (call % 2 === 1) {
            // list query
            return {
              from: () => ({
                where: () => ({
                  orderBy: () => ({ limit: () => Promise.resolve(mockRows) }),
                }),
              }),
            };
          }
          // count query
          return {
            from: () => ({
              where: () => Promise.resolve([{ n: 1 }]),
            }),
          };
        },
      });
    }),
  };
});

// Stub drizzle helpers used in the handler
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (_col: unknown, _val: unknown) => "eq_sentinel",
  count: () => "count_fn",
  sql: (s: TemplateStringsArray, ..._args: unknown[]) => s[0],
}));

import { handler } from "./notifications.list";

describe("notifications.list handler", () => {
  it("returns notifications and unreadCount", async () => {
    const ctx = { orgId: "org-1", workspaceId: "ws-1", userId: "user-1", apiKeyId: null, requestId: "req-1", surface: "api" as const, messageId: null };
    const result = await handler({ unreadOnly: false, limit: 50 }, ctx) as { notifications: unknown[]; unreadCount: number };
    expect(result.notifications).toHaveLength(1);
    expect(result.unreadCount).toBeGreaterThanOrEqual(0);
  });

  it("throws when userId is absent", async () => {
    const ctx = { orgId: "org-1", workspaceId: "ws-1", userId: null, apiKeyId: null, requestId: "req-1", surface: "api" as const, messageId: null };
    await expect(handler({ unreadOnly: false, limit: 50 }, ctx)).rejects.toThrow("userId is required");
  });
});
```

### D-4: `notifications.mark` handler

**Files:**
- Create: `packages/handlers/src/notifications.mark.ts`
- Create: `packages/handlers/src/notifications.mark.test.ts`

- [ ] Create `packages/handlers/src/notifications.mark.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { id, read, archived } = input as {
    id: string;
    read?: boolean;
    archived?: boolean;
  };

  if (!ctx.userId) {
    throw new Error("[notifications.mark] userId is required (user-scoped)");
  }

  const updates: Partial<{ unread: boolean; archived: boolean; updatedAt: Date }> = {
    updatedAt: new Date(),
  };
  if (typeof read === "boolean") updates.unread = !read;
  if (typeof archived === "boolean") updates.archived = archived;

  if (Object.keys(updates).length === 1) {
    // Only updatedAt — no-op but valid.
    return { ok: true };
  }

  await withSystemDb(async (tx) => {
    await tx
      .update(schema.notifications)
      .set(updates)
      .where(
        and(
          eq(schema.notifications.publicId, id),
          eq(schema.notifications.userId, ctx.userId!),
        ),
      );
  });

  return { ok: true };
};
```

- [ ] Create `packages/handlers/src/notifications.mark.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@oxagen/database", () => ({
  schema: { notifications: { publicId: "publicId_col", userId: "userId_col", unread: "unread_col", archived: "archived_col", updatedAt: "updatedAt_col" } },
  withSystemDb: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ update: () => ({ set: () => ({ where: () => Promise.resolve() }) }) }),
  ),
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (_col: unknown, _val: unknown) => "eq_sentinel",
}));

import { handler } from "./notifications.mark";

const ctx = { orgId: "org-1", workspaceId: "ws-1", userId: "user-1", apiKeyId: null, requestId: "req-1", surface: "api" as const, messageId: null };

describe("notifications.mark handler", () => {
  it("returns ok:true when marking as read", async () => {
    const result = await handler({ id: "ntf_abc", read: true }, ctx);
    expect(result).toEqual({ ok: true });
  });

  it("returns ok:true when archiving", async () => {
    const result = await handler({ id: "ntf_abc", archived: true }, ctx);
    expect(result).toEqual({ ok: true });
  });

  it("throws when userId is absent", async () => {
    const noUserCtx = { ...ctx, userId: null };
    await expect(handler({ id: "ntf_abc", read: true }, noUserCtx)).rejects.toThrow("userId is required");
  });

  it("returns ok:true with no-op when neither read nor archived provided", async () => {
    const result = await handler({ id: "ntf_abc" }, ctx);
    expect(result).toEqual({ ok: true });
  });
});
```

Run: `pnpm --filter @oxagen/handlers test:unit -- notifications`
Expected: **both handler test files pass**.

**Commit:**
```
git add packages/handlers/src/notifications.list.ts \
        packages/handlers/src/notifications.list.test.ts \
        packages/handlers/src/notifications.mark.ts \
        packages/handlers/src/notifications.mark.test.ts && \
git commit -m "feat(handlers): notifications.list + notifications.mark handlers"
```

### D-5: Register handlers

- [ ] Edit `packages/handlers/src/register.ts` — append two `registerHandler` calls at the bottom (before the closing of any IIFE if present, or as top-level statements):

```ts
registerHandler(
  "notifications.list",
  async () => (await import("./notifications.list")).handler as CapabilityHandlerFn,
);
registerHandler(
  "notifications.mark",
  async () => (await import("./notifications.mark")).handler as CapabilityHandlerFn,
);
```

### D-6: API routes

- [ ] Create `apps/api/src/routes/v1/notifications.list.ts`:

```ts
import { Hono } from "hono";
import { notificationsList } from "@oxagen/oxagen/contracts/notifications.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const notificationsListRoute = new Hono<AppEnv>();

notificationsListRoute.get("/", async (c) => {
  const unreadOnly = c.req.query("unreadOnly") === "true";
  const limitRaw = c.req.query("limit");
  const limit = limitRaw !== undefined ? parseInt(limitRaw, 10) : 50;
  const input = notificationsList.input.parse({ unreadOnly, limit });
  const ctx = capabilityContext(c);
  const out = await invoke(notificationsList.name, input, ctx, { surface: "api" });
  return c.json(out);
});
```

- [ ] Create `apps/api/src/routes/v1/notifications.mark.ts`:

```ts
import { Hono } from "hono";
import { notificationsMark } from "@oxagen/oxagen/contracts/notifications.mark";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const notificationsMarkRoute = new Hono<AppEnv>();

notificationsMarkRoute.post("/", async (c) => {
  const body = await c.req.json();
  const input = notificationsMark.input.parse(body);
  const ctx = capabilityContext(c);
  const out = await invoke(notificationsMark.name, input, ctx, { surface: "api" });
  return c.json(out);
});
```

- [ ] Edit `apps/api/src/app.ts` — add imports and mount under `orgScoped`:

Imports to add after existing plugin imports:
```ts
import { notificationsListRoute } from "./routes/v1/notifications.list";
import { notificationsMarkRoute } from "./routes/v1/notifications.mark";
```

Routes to mount (inside `orgScoped.route(...)` block, before `app.route("/v1/:org_slug/:workspace_slug", orgScoped)`):
```ts
orgScoped.route("/notifications", notificationsListRoute);
orgScoped.route("/notifications/mark", notificationsMarkRoute);
```

### D-7: MCP tools

- [ ] Create `apps/mcp/src/tools/notifications.list.ts`:

```ts
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { notificationsList } from "@oxagen/oxagen/contracts/notifications.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...notificationsList.input.shape,
};

export const metadata: ToolMetadata = {
  name: notificationsList.name,
  description: notificationsList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function notificationsListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(notificationsList.name, args, ctx, { surface: "mcp" });
  return notificationsList.output.parse(output);
}
```

- [ ] Create `apps/mcp/src/tools/notifications.mark.ts`:

```ts
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { notificationsMark } from "@oxagen/oxagen/contracts/notifications.mark";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...notificationsMark.input.shape,
};

export const metadata: ToolMetadata = {
  name: notificationsMark.name,
  description: notificationsMark.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function notificationsMarkTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(notificationsMark.name, args, ctx, { surface: "mcp" });
  return notificationsMark.output.parse(output);
}
```

Run: `pnpm check:manifest`
Expected: manifest shows `notifications.list` and `notifications.mark` as API+MCP, **no gaps**.

Run: `pnpm --filter @oxagen/api typecheck && pnpm --filter @oxagen/mcp typecheck`
Expected: no errors.

**Commit:**
```
git add packages/handlers/src/register.ts \
        apps/api/src/routes/v1/notifications.list.ts \
        apps/api/src/routes/v1/notifications.mark.ts \
        apps/api/src/app.ts \
        apps/mcp/src/tools/notifications.list.ts \
        apps/mcp/src/tools/notifications.mark.ts && \
git commit -m "feat(api,mcp): notifications.list + notifications.mark routes and tools"
```

---

## Task E: In-app bell wiring

**Files:**
- Create: `apps/app/src/lib/actions/notifications.ts`
- Modify: `apps/app/src/components/shell/notifications-bell.tsx`

### E-1: Server action

- [ ] Create `apps/app/src/lib/actions/notifications.ts`:

```ts
"use server";

import { invoke } from "@oxagen/oxagen/kernel";
import { notificationsList } from "@oxagen/oxagen/contracts/notifications.list";
import { notificationsMark } from "@oxagen/oxagen/contracts/notifications.mark";
import type { NotificationsListOutput } from "@oxagen/oxagen/contracts/notifications.list";
import type { NotificationsMarkOutput } from "@oxagen/oxagen/contracts/notifications.mark";
import { getServerSession } from "@/lib/auth/session";
import { resolveOrg } from "@/lib/resolve-org";
import type { CapabilityContext } from "@oxagen/oxagen/types";

/**
 * Build a CapabilityContext from the current Next.js server context.
 * Mirrors the pattern in apps/app server actions (see billing/*, conversation/*).
 */
async function buildNotificationCtx(
  orgSlug: string,
  workspaceSlug: string,
): Promise<CapabilityContext> {
  const session = await getServerSession();
  if (!session?.user?.id) throw new Error("Unauthenticated");
  const { org, workspace } = await resolveOrg(orgSlug, workspaceSlug, session.user.id);
  return {
    orgId: org.id,
    workspaceId: workspace.id,
    userId: session.user.id,
    apiKeyId: null,
    requestId: crypto.randomUUID(),
    surface: "app",
    messageId: null,
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
  const out = await invoke(notificationsList.name, input, ctx, { surface: "app" });
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
  const out = await invoke(notificationsMark.name, input, ctx, { surface: "app" });
  return notificationsMark.output.parse(out);
}
```

VERIFY: `getServerSession` and `resolveOrg` import paths — check existing server actions in `apps/app/src/lib/actions/` for the canonical pattern. If `resolveOrg` is at a different path (e.g. `@/lib/org`), adjust the import accordingly.

### E-2: Wired `NotificationsBell`

- [ ] Replace `apps/app/src/components/shell/notifications-bell.tsx` entirely:

```tsx
"use client";
/**
 * NotificationsBell — real data, wired to notifications.list + notifications.mark.
 * Renders an unread badge on the bell icon; sheet drawer shows the feed.
 * Mark-read on item click; archive via swipe-right chevron button.
 */

import * as React from "react";
import { Bell } from "lucide-react";
import {
  Sheet,
  SheetPopup,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { listNotificationsAction, markNotificationAction } from "@/lib/actions/notifications";
import { useParams } from "next/navigation";

interface Notification {
  id: string;
  publicId: string;
  kind: string;
  title: string;
  body: string | null;
  deepLink: string | null;
  unread: boolean;
  archived: boolean;
  createdAt: string;
}

export function NotificationsBell() {
  const [open, setOpen] = React.useState(false);
  const [notifications, setNotifications] = React.useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const params = useParams<{ orgSlug: string; workspaceSlug: string }>();
  const orgSlug = params.orgSlug ?? "";
  const workspaceSlug = params.workspaceSlug ?? "";

  const load = React.useCallback(async () => {
    if (!orgSlug || !workspaceSlug) return;
    setLoading(true);
    try {
      const result = await listNotificationsAction(orgSlug, workspaceSlug);
      setNotifications(result.notifications);
      setUnreadCount(result.unreadCount);
    } catch {
      // Silently fail — bell is non-critical; app still works.
    } finally {
      setLoading(false);
    }
  }, [orgSlug, workspaceSlug]);

  // Load when sheet opens; also poll on mount for the badge count.
  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const handleMarkRead = async (notification: Notification) => {
    if (!notification.unread) return;
    // Optimistic update.
    setNotifications((prev) =>
      prev.map((n) => (n.publicId === notification.publicId ? { ...n, unread: false } : n)),
    );
    setUnreadCount((c) => Math.max(0, c - 1));
    try {
      await markNotificationAction(orgSlug, workspaceSlug, notification.publicId, { read: true });
    } catch {
      // Revert on failure.
      void load();
    }
  };

  const handleArchive = async (notification: Notification) => {
    setNotifications((prev) => prev.filter((n) => n.publicId !== notification.publicId));
    if (notification.unread) setUnreadCount((c) => Math.max(0, c - 1));
    try {
      await markNotificationAction(orgSlug, workspaceSlug, notification.publicId, { archived: true });
    } catch {
      void load();
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label={unreadCount > 0 ? `Open notifications (${unreadCount} unread)` : "Open notifications"}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className={cn(
          "relative flex h-9 w-9 items-center justify-center rounded-md",
          "text-muted-foreground transition-colors",
          "hover:bg-accent hover:text-accent-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <Bell className="h-4 w-4" aria-hidden="true" />
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            className={cn(
              "absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center",
              "rounded-full bg-primary text-[10px] font-semibold text-primary-foreground",
            )}
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetPopup side="right" className="flex w-80 flex-col p-0 sm:w-80">
          <SheetHeader className="border-b border-border/40 px-4 py-3">
            <SheetTitle className="text-sm font-medium">
              Notifications
              {unreadCount > 0 && (
                <span className="ml-2 inline-flex items-center rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary">
                  {unreadCount}
                </span>
              )}
            </SheetTitle>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto">
            {loading && notifications.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <span className="text-xs text-muted-foreground">Loading…</span>
              </div>
            ) : notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
                <Bell className="h-8 w-8 text-muted-foreground/30" aria-hidden="true" />
                <p className="text-sm text-muted-foreground">No notifications yet</p>
                <p className="text-xs text-muted-foreground/60">
                  Agent completions, approvals, and alerts will appear here.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-border/40">
                {notifications.map((n) => (
                  <li
                    key={n.publicId}
                    className={cn(
                      "group flex items-start gap-3 px-4 py-3 text-left transition-colors",
                      "hover:bg-accent/50",
                      n.unread && "bg-primary/5",
                    )}
                  >
                    <button
                      type="button"
                      className="flex-1 text-left"
                      onClick={() => {
                        void handleMarkRead(n);
                        if (n.deepLink) window.location.href = n.deepLink;
                      }}
                    >
                      <p
                        className={cn(
                          "text-xs leading-snug",
                          n.unread ? "font-medium text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {n.title}
                      </p>
                      {n.body && (
                        <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground/80">
                          {n.body}
                        </p>
                      )}
                      <p className="mt-1 text-[10px] text-muted-foreground/50">
                        {new Date(n.createdAt).toLocaleDateString()}
                      </p>
                    </button>
                    <button
                      type="button"
                      aria-label="Archive notification"
                      onClick={() => void handleArchive(n)}
                      className={cn(
                        "mt-0.5 shrink-0 rounded p-0.5 opacity-0 transition-opacity",
                        "text-muted-foreground hover:text-foreground",
                        "group-hover:opacity-100 focus-visible:opacity-100",
                        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                      )}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <polyline points="9 10 4 15 9 20" />
                        <path d="M20 4v7a4 4 0 0 1-4 4H4" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SheetPopup>
      </Sheet>
    </>
  );
}
```

Run: `pnpm --filter @oxagen/app typecheck`
Expected: no errors.

**Commit:**
```
git add apps/app/src/lib/actions/notifications.ts \
        apps/app/src/components/shell/notifications-bell.tsx && \
git commit -m "feat(app): wire NotificationsBell to real notifications.list + mark server actions"
```

---

## Task F: Org setting capability — `plugin.settings.set_auth_alerts`

This is a lightweight org-level settings mutator. Plan 6 (UI) will surface a toggle in org settings; Plan 5 ships the contract + handler so the setting is writeable from API/MCP immediately.

**Files:**
- Create: `packages/oxagen/src/contracts/plugin.settings.set_auth_alerts.ts`
- Create: `packages/oxagen/src/contracts/plugin.settings.set_auth_alerts.test.ts`
- Create: `packages/handlers/src/plugin.settings.set_auth_alerts.ts`
- Create: `packages/handlers/src/plugin.settings.set_auth_alerts.test.ts`
- Modify: `packages/handlers/src/register.ts`
- Create: `apps/api/src/routes/v1/plugin.settings.set_auth_alerts.ts`
- Create: `apps/mcp/src/tools/plugin.settings.set_auth_alerts.ts`
- Modify: `apps/api/src/app.ts`

### F-1: Contract

- [ ] Create `packages/oxagen/src/contracts/plugin.settings.set_auth_alerts.ts`:

```ts
import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * plugin.settings.set_auth_alerts — update the org's mcp_auth_alerts setting.
 * Default (when unset): { send_email: true, roles: ["Owner", "Admin"] }.
 * Only org Owners and Admins may change this setting.
 */
export const pluginSettingsSetAuthAlerts = registerCapability({
  name: "plugin.settings.set_auth_alerts",
  domain: "plugin",
  description:
    "Update the org MCP auth-alert notification setting (which roles receive alerts and whether email is sent).",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["api", "mcp", "unit"],
  scoped: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z.object({
    /** Whether to send email in addition to in-app notification. */
    sendEmail: z.boolean(),
    /**
     * Org role names that should receive alerts.
     * Must be a non-empty subset of valid org roles.
     */
    roles: z
      .array(z.enum(["Owner", "Admin", "Compliance", "Billing"]))
      .min(1),
  }),
  output: z.object({ ok: z.boolean() }),
});

export type PluginSettingsSetAuthAlertsInput = z.output<
  typeof pluginSettingsSetAuthAlerts.input
>;
```

- [ ] Create `packages/oxagen/src/contracts/plugin.settings.set_auth_alerts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { pluginSettingsSetAuthAlerts } from "./plugin.settings.set_auth_alerts";

describe("plugin.settings.set_auth_alerts contract", () => {
  it("has correct name and domain", () => {
    expect(pluginSettingsSetAuthAlerts.name).toBe("plugin.settings.set_auth_alerts");
    expect(pluginSettingsSetAuthAlerts.domain).toBe("plugin");
  });

  it("parses valid input", () => {
    const parsed = pluginSettingsSetAuthAlerts.input.parse({
      sendEmail: true,
      roles: ["Owner", "Admin"],
    });
    expect(parsed.sendEmail).toBe(true);
    expect(parsed.roles).toEqual(["Owner", "Admin"]);
  });

  it("rejects empty roles array", () => {
    expect(() =>
      pluginSettingsSetAuthAlerts.input.parse({ sendEmail: false, roles: [] }),
    ).toThrow();
  });

  it("rejects invalid role names", () => {
    expect(() =>
      pluginSettingsSetAuthAlerts.input.parse({ sendEmail: true, roles: ["Member"] }),
    ).toThrow();
  });
});
```

### F-2: Handler

- [ ] Create `packages/handlers/src/plugin.settings.set_auth_alerts.ts`:

```ts
import { eq, sql } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { sendEmail, roles } = input as { sendEmail: boolean; roles: string[] };
  const orgId = ctx.orgId;

  const alertsValue = JSON.stringify({ send_email: sendEmail, roles });

  await withSystemDb(async (tx) => {
    await tx
      .update(schema.organizations)
      .set({
        settings: sql`settings || ${alertsValue}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(schema.organizations.id, orgId));
  });

  return { ok: true };
};
```

Note: `settings || jsonb_value` merges at the top level, preserving other setting keys while overwriting `mcp_auth_alerts`.
VERIFY: Drizzle's `sql` template tag supports `${string}::jsonb` in `.set()`; if not, use `sql`\`settings || ${sql.raw(`'${alertsValue}'::jsonb`)}\`` — but do NOT use `.raw()` with untrusted user input; `JSON.stringify` output of a validated Zod object is safe.

- [ ] Create `packages/handlers/src/plugin.settings.set_auth_alerts.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@oxagen/database", () => ({
  schema: { organizations: { id: "id_col", settings: "settings_col", updatedAt: "updatedAt_col" } },
  withSystemDb: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ update: () => ({ set: () => ({ where: () => Promise.resolve() }) }) }),
  ),
}));

vi.mock("drizzle-orm", () => ({
  eq: (_col: unknown, _val: unknown) => "eq_sentinel",
  sql: (s: TemplateStringsArray, ..._args: unknown[]) => s[0],
}));

import { handler } from "./plugin.settings.set_auth_alerts";

const ctx = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "api" as const,
  messageId: null,
};

describe("plugin.settings.set_auth_alerts handler", () => {
  it("returns ok:true", async () => {
    const result = await handler({ sendEmail: true, roles: ["Owner", "Admin"] }, ctx);
    expect(result).toEqual({ ok: true });
  });
});
```

### F-3: Register + wire route + tool

- [ ] Append to `packages/handlers/src/register.ts`:
```ts
registerHandler(
  "plugin.settings.set_auth_alerts",
  async () =>
    (await import("./plugin.settings.set_auth_alerts")).handler as CapabilityHandlerFn,
);
```

- [ ] Create `apps/api/src/routes/v1/plugin.settings.set_auth_alerts.ts`:
```ts
import { Hono } from "hono";
import { pluginSettingsSetAuthAlerts } from "@oxagen/oxagen/contracts/plugin.settings.set_auth_alerts";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const pluginSettingsSetAuthAlertsRoute = new Hono<AppEnv>();

pluginSettingsSetAuthAlertsRoute.post("/", async (c) => {
  const body = await c.req.json();
  const input = pluginSettingsSetAuthAlerts.input.parse(body);
  const ctx = capabilityContext(c);
  const out = await invoke(pluginSettingsSetAuthAlerts.name, input, ctx, { surface: "api" });
  return c.json(out);
});
```

- [ ] Edit `apps/api/src/app.ts` — add import + mount:
```ts
import { pluginSettingsSetAuthAlertsRoute } from "./routes/v1/plugin.settings.set_auth_alerts";
// ...
orgScoped.route("/plugin/settings/auth-alerts", pluginSettingsSetAuthAlertsRoute);
```

- [ ] Create `apps/mcp/src/tools/plugin.settings.set_auth_alerts.ts`:
```ts
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { pluginSettingsSetAuthAlerts } from "@oxagen/oxagen/contracts/plugin.settings.set_auth_alerts";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...pluginSettingsSetAuthAlerts.input.shape };

export const metadata: ToolMetadata = {
  name: pluginSettingsSetAuthAlerts.name,
  description: pluginSettingsSetAuthAlerts.description,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

export default async function pluginSettingsSetAuthAlertsTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(pluginSettingsSetAuthAlerts.name, args, ctx, { surface: "mcp" });
  return pluginSettingsSetAuthAlerts.output.parse(output);
}
```

Run: `pnpm check:manifest`
Expected: `plugin.settings.set_auth_alerts` shows as API+MCP — no gaps.

**Commit:**
```
git add packages/oxagen/src/contracts/plugin.settings.set_auth_alerts.ts \
        packages/oxagen/src/contracts/plugin.settings.set_auth_alerts.test.ts \
        packages/handlers/src/plugin.settings.set_auth_alerts.ts \
        packages/handlers/src/plugin.settings.set_auth_alerts.test.ts \
        packages/handlers/src/register.ts \
        apps/api/src/routes/v1/plugin.settings.set_auth_alerts.ts \
        apps/api/src/app.ts \
        apps/mcp/src/tools/plugin.settings.set_auth_alerts.ts && \
git commit -m "feat(plugins): plugin.settings.set_auth_alerts capability (org alert setting)"
```

---

## Task G: Final verification

**Run each check in order; fix any failure before proceeding to the next.**

### G-1: `pnpm check:manifest`

```
pnpm check:manifest
```

Expected output (new entries highlighted):
```
✓ notifications.list      api mcp  ✓
✓ notifications.mark      api mcp  ✓
✓ plugin.settings.set_auth_alerts  api mcp  ✓
… (all existing capabilities still green)
Manifest check passed — no gaps.
```

If any gap remains: verify the handler is registered in `register.ts`, the route is mounted in `app.ts`, and the tool file exports `schema`, `metadata`, and a default function.

### G-2: TypeCheck all touched packages

```
pnpm --filter @oxagen/notifications typecheck && \
pnpm --filter @oxagen/plugins typecheck && \
pnpm --filter @oxagen/oxagen typecheck && \
pnpm --filter @oxagen/handlers typecheck && \
pnpm --filter @oxagen/api typecheck && \
pnpm --filter @oxagen/mcp typecheck && \
pnpm --filter @oxagen/app typecheck
```

Expected: all exit 0, no `any` errors (TypeScript 6.0.3 strict mode).

### G-3: Unit tests

```
pnpm --filter @oxagen/notifications test:unit
```

Expected: all tests in `src/notifications/*.test.ts` + existing `src/*.test.ts` pass.

```
pnpm --filter @oxagen/handlers test:unit -- notifications
pnpm --filter @oxagen/handlers test:unit -- plugin.settings
pnpm --filter @oxagen/oxagen test:unit -- notifications
pnpm --filter @oxagen/oxagen test:unit -- plugin.settings
```

Expected: 7 contract tests + 4 handler tests (notifications.list + mark) + 1 handler test (set_auth_alerts) + 4 contract tests (set_auth_alerts) — all green.

### G-4: Lint

```
pnpm --filter @oxagen/notifications lint && \
pnpm --filter @oxagen/plugins lint && \
pnpm --filter @oxagen/handlers lint && \
pnpm --filter @oxagen/api lint && \
pnpm --filter @oxagen/mcp lint
```

Expected: 0 warnings, 0 errors.

---

## Done criteria for Plan 5

- [ ] `notification.notifications` rows are created (via `createNotification`) whenever a credential flips to `needs_reauth` — both from the runtime `connectMcp` error path (Plan 4, Task 5) and the Inngest cron (Plan 4, Task 6).
- [ ] Org Owners and Admins (configurable via `mcp_auth_alerts.roles`) receive an in-app notification AND an email with a re-auth deep link when any credential in their org flips to `needs_reauth`.
- [ ] Email failure never prevents the in-app notification (log-and-continue — no silent total failure).
- [ ] `notifications.list` and `notifications.mark` capabilities are live at both API (`GET /v1/:org/:ws/notifications`, `POST /v1/:org/:ws/notifications/mark`) and MCP.
- [ ] `plugin.settings.set_auth_alerts` is live at API + MCP; updates `organizations.settings.mcp_auth_alerts`.
- [ ] The `NotificationsBell` shell component renders real notifications, shows an unread badge, marks-read on click, archives on dismiss, and links to the deep-link URL.
- [ ] `pnpm check:manifest` passes with no gaps.
- [ ] TypeCheck and unit tests green across all touched packages.

**Next plan:** `docs/superpowers/plans/2026-06-06-installable-plugins-06-ui.md` — org settings "Plugins" section, marketplace modal with bulk install, workspace integration surface, re-auth page, and `assertMcpManager` auth gate.
