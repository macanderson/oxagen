// Organization and workspace choices (ARCHITECTURE.md §3.3): the organizations
// the viewer belongs to and the workspaces of one organization the viewer is a
// member of, for the shell's switchers and the CLI consent picker.
import { z } from "zod";
import { PublicId } from "./common";

export const OrgChoice = z.object({
  slug: z.string().min(1),
  name: z.string(),
});

export type OrgChoice = z.infer<typeof OrgChoice>;

export const WorkspaceChoice = z.object({
  slug: z.string().min(1),
  name: z.string(),
});
export type WorkspaceChoice = z.infer<typeof WorkspaceChoice>;

export const ShellContext = z.object({
  orgs: z.array(OrgChoice),
  workspaces: z.array(WorkspaceChoice),
});
export type ShellContext = z.infer<typeof ShellContext>;

/**
 * The person's own clock, read for the shell and for every page under it: the
 * IANA zone next-intl formats each date in. One field today; the other account
 * preferences join it here when a surface reads them.
 */
export const ViewerPreferences = z.object({
  timeZone: z.string().min(1),
});
export type ViewerPreferences = z.infer<typeof ViewerPreferences>;

const Count = z.number().int().nonnegative();

/**
 * The sidebar's counts for one workspace (`get_nav_counts`, mockup
 * `sidebar()`): what waits on a person there. Each is null when its store does
 * not exist, and a null draws no count rather than a zero: rev1 records
 * approvals, and has no proposals or incident store behind the other two.
 */
export const NavCounts = z.object({
  approvals: Count.nullable(),
  proposals: Count.nullable(),
  incidents: Count.nullable(),
});
export type NavCounts = z.infer<typeof NavCounts>;

/**
 * One row of the viewer's in-app feed (`list_notifications`, mockup
 * `notifsBody()`). `event` is the §7.7 event that produced it, the mono line a
 * row carries, or null for a row no event produced.
 */
export const ShellNotification = z.object({
  id: PublicId,
  title: z.string(),
  body: z.string().nullable(),
  event: z.string().min(1).nullable(),
  kind: z.enum(["system", "approval", "run", "member", "security"]),
  unread: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type ShellNotification = z.infer<typeof ShellNotification>;

/** The feed as the bell reads it: the newest rows and the unread count over the whole feed. */
export const NotificationFeed = z.object({
  items: z.array(ShellNotification),
  unread: Count,
});
export type NotificationFeed = z.infer<typeof NotificationFeed>;
