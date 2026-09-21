// What the server hands the client shell: the organization and the person the
// organization layout's viewer resolved (ARCHITECTURE.md §3.1), the
// `shell.context` read the org and workspace switchers list, and the count the
// thumb bar's Fleet slot shows.
import type { ShellContext } from "@/data/contracts/shell";
import type { Read } from "@/data/read";

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
  /**
   * Approvals waiting on a person, shown on the Fleet slot. Null until the
   * #2968 lane binds nav counts to a live read (ARCHITECTURE.md §1.2): no rev1
   * port counts approvals across an organization's workspaces.
   */
  fleetWaiting: number | null;
};
