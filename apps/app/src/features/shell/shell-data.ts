// What the server hands the client shell: the organization and the person the
// organization layout's viewer resolved (ARCHITECTURE.md §3.1), the
// `shell.context` read the org and workspace switchers list, and the count the
// thumb bar's Fleet slot shows.
import type {
  ApprovalQueue,
  ResolvedApprovalItem,
} from "@/data/contracts/approvals";
import type {
  NavCounts,
  NotificationFeed,
  ShellContext,
} from "@/data/contracts/shell";
import type { Read } from "@/data/read";

/**
 * One workspace's share of the approvals drawer (mockup `apdBody()`): the calls
 * parked there, and what was resolved there since the start of the viewer's
 * day. `list_approvals` and `list_resolved_approvals` are workspace-scoped, so
 * the drawer is the sum of these.
 */
export type WorkspaceApprovals = {
  slug: string;
  name: string;
  pending: Read<ApprovalQueue>;
  resolved: Read<{ items: ResolvedApprovalItem[]; more: boolean }>;
};

/**
 * Everything waiting on the viewer across the organization, as the topbar's
 * approvals button counts it and the drawer lists it. `truncated` is true
 * when the organization has more workspaces than the chrome reads, so the
 * count says "+" rather than a total it cannot stand behind.
 */
export type ShellApprovals = {
  workspaces: WorkspaceApprovals[];
  truncated: boolean;
  /** The instant the reads were made: every countdown in the drawer ticks from it. */
  readAt: number;
};

export type ShellData = {
  org: { key: string; slug: string; name: string };
  viewer: {
    name: string | null;
    email: string;
    avatarUrl: string | null;
    /** The person's principal id, shown on the Profile tab beside their roles. */
    id: string;
    /** The viewer's role in this organization, lowercased (server/viewer.ts OrgRole). */
    orgRole: string;
    emailVerified: boolean;
    twoFactorEnabled: boolean;
    /** The IANA zone the chrome's dates render in, and the Account dialog's current choice. */
    timeZone: string;
  };
  context: Read<ShellContext>;
  /** The approvals drawer and the counts read off it. */
  approvals: ShellApprovals;
  /**
   * The bell's feed for the organization's first workspace, the one the
   * sidebar points at on an organization page. A workspace page replaces it
   * with its own (`<ShellWorkspace>`): `list_notifications` is workspace-scoped
   * and answers the organization's rows plus that workspace's. Null when the
   * organization has no workspace to read it in.
   */
  feed: Read<NotificationFeed> | null;
  /**
   * The sidebar's Steering and Audit counts (`get_nav_counts`) for the same
   * first workspace, so an organization page (Organization, Billing, Audit)
   * draws them the way a workspace page does. A workspace page replaces them
   * with its own. Null when the organization has no workspace to read.
   */
  counts: { slug: string; read: Read<NavCounts> } | null;
};
