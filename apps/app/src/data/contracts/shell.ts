// The shell: people, notifications and the assistant engine's health
// (spec §14.1, §18 "Engine availability").
import { z } from "zod";
import {
  Avatar,
  Instant,
  OrgRole,
  PublicId,
  Slug,
  WorkspaceRole,
} from "./common";
import { MfaFactor } from "./org";

export const Person = z.object({
  id: PublicId,
  name: z.string(),
  email: z.email(),
  initials: z.string().min(1).max(3),
  orgRole: OrgRole,
  workspaceRoles: z.array(z.object({ slug: Slug, role: WorkspaceRole })),
  mfa: z.array(MfaFactor),
  avatar: Avatar,
});
export type Person = z.infer<typeof Person>;

/** The decision vocabulary a notification is drawn in. */
export const NotificationTone = z.enum([
  "approval",
  "failed",
  "allowed",
  "steering",
  "critical",
]);
export type NotificationTone = z.infer<typeof NotificationTone>;

export const Notification = z.object({
  id: PublicId,
  /** A frame kind or an audit event kind; nothing is invented for a bell. */
  kind: z.string().regex(/^[a-z_]+(\.[a-z_]+)*$/),
  tone: NotificationTone,
  unread: z.boolean(),
  at: Instant,
  title: z.string(),
  body: z.string(),
  runId: PublicId.nullable(),
  /** Where the notification leads: a run, approval, PR, repository or switch id. */
  ref: z.string().nullable(),
});
export type Notification = z.infer<typeof Notification>;

/** W9: the flyout reads this; every other screen works with the engine down. */
export const AssistantEngineHealth = z.object({
  status: z.enum(["up", "down"]),
  checkedAt: Instant,
});
export type AssistantEngineHealth = z.infer<typeof AssistantEngineHealth>;
