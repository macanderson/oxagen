// Organization › People and Organization › Invitations (pages/organization.md):
// the members and the pending invitations of `list_members {scope:"org"}`,
// which the frame reads once and hands to both tabs.
//
// People: Person, Role, Workspaces, Two-factor, Last seen and Status, with
// Open, Change role and Remove on each row, then Roles in use, which counts
// the People table by role and takes each role's description from the role
// catalogue. `list_members` records a member's name, email, role and join
// date. It records no per-member workspaces, two-factor method or last sign-in,
// so those cells say "not recorded" rather than a guess (#3932). The badge
// states the organization's two-factor policy, which the frame reads from the
// record the MFA gate enforces (security.org_security_policy).
// Every member on the roster holds a membership row, so Status reads "active".
//
// Invitations: Email, Role offered, Invited by, Sent and Expires, with Resend
// and Revoke, filtered by the day it was sent and the day it expires. The
// contract does not return who sent an invitation, so Invited by says "not
// recorded".
import { useTranslations } from "next-intl";
import type { MemberList, RoleCatalog } from "@/data/contracts/org";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import {
  buttonSecondary,
  mono,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { SafeLink } from "@/ui/navigation";
import { cell, headCell, numericCell } from "@/ui/table";
import { InvitationControls } from "./invitation-controls";
import { InviteDialog } from "./invite-dialog";
import { type ListRow, ListTable } from "./list-table";
import { MemberRowActions } from "./member-row-actions";
import { DateCell, NotRecorded, note } from "./parts";

type Member = MemberList["members"][number];

function PersonCell({ member }: { member: Member }) {
  return (
    <>
      <div className="font-semibold text-foreground">
        {member.name ?? member.email}
      </div>
      <div className={`${mono} text-[11px] text-dim`}>{member.email}</div>
    </>
  );
}

/**
 * The member dialog (mockup `member`): the person's facts, then Role per
 * workspace, Agents they operate and Mandates. `list_members` carries the
 * org role and the join date; it carries no per-workspace role, no agents a
 * person operates and no mandates, so those sections say "not recorded"
 * (#3932).
 */
function MemberFacts({ member }: { member: Member }) {
  const t = useTranslations("organization.people.member");
  const tRole = useTranslations("organization.roles");
  const term = "text-muted-foreground";
  const sectionTitle =
    "mt-4 mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-dim";
  return (
    <div data-issue="3932">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className={term}>{t("email")}</dt>
        <dd className={mono}>{member.email}</dd>
        <dt className={term}>{t("role")}</dt>
        <dd className={mono}>{tRole(member.role)}</dd>
        <dt className={term}>{t("joined")}</dt>
        <dd>
          <DateCell iso={member.joinedAt} />
        </dd>
        <dt className={term}>{t("twoFactor")}</dt>
        <dd>
          <NotRecorded />
        </dd>
        <dt className={term}>{t("lastSeen")}</dt>
        <dd>
          <NotRecorded />
        </dd>
        <dt className={term}>{t("id")}</dt>
        <dd className={`${mono} select-all`}>{member.id}</dd>
      </dl>
      <h3 className={sectionTitle}>{t("perWorkspace")}</h3>
      <table aria-label={t("perWorkspace")} className="w-full text-[13px]">
        <thead>
          <tr>
            <th scope="col" className={`${headCell} text-left`}>
              {t("workspace")}
            </th>
            <th scope="col" className={`${headCell} text-left`}>
              {t("workspaceRole")}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr data-member-workspaces="not-recorded">
            <td className={cell}>
              <NotRecorded />
            </td>
            <td className={cell}>
              <NotRecorded />
            </td>
          </tr>
        </tbody>
      </table>
      <h3 className={sectionTitle}>{t("agents")}</h3>
      <p data-member-agents="not-recorded">
        <NotRecorded />
      </p>
      <h3 className={sectionTitle}>{t("mandates")}</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className={term}>{t("granted")}</dt>
        <dd>
          <NotRecorded />
        </dd>
        <dt className={term}>{t("heldByAgents")}</dt>
        <dd>
          <NotRecorded />
        </dd>
      </dl>
    </div>
  );
}

export function PeopleTab({
  org,
  members,
  roles,
  twoFactorRequired,
}: {
  org: string;
  members: MemberList;
  roles: RoleCatalog;
  /** security.org_security_policy.mfa_required, as the frame read it. */
  twoFactorRequired: boolean;
}) {
  const t = useTranslations("organization.people");
  const tRole = useTranslations("organization.roles");
  const here = routes.people(org);
  const columns = [
    { label: t("person") },
    { label: t("role") },
    { label: t("workspaces") },
    { label: t("twoFactor") },
    { label: t("lastSeen") },
    { label: t("status") },
    { label: t("actions"), hidden: true },
  ];
  const rows: ListRow[] = members.members.map((member) => ({
    key: member.id,
    rowId: member.id,
    values: { status: "active" },
    cells: [
      <PersonCell key="person" member={member} />,
      <span key="role" className={`${mono} text-[11.5px]`}>
        {tRole(member.role)}
      </span>,
      <NotRecorded key="workspaces" />,
      <NotRecorded key="twoFactor" />,
      <NotRecorded key="lastSeen" />,
      <Badge key="status" tone="allowed" data-status="active">
        {t("statusActive")}
      </Badge>,
      <MemberRowActions
        key="actions"
        org={org}
        member={member}
        allowed
        after={here}
        details={<MemberFacts member={member} />}
      />,
    ],
  }));
  return (
    <div className="flex flex-col gap-3.5">
      <section aria-labelledby="org-people" className={panel}>
        <div className={panelHeader}>
          <h2 id="org-people" className={panelTitle}>
            {t("title")}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              tone={twoFactorRequired ? "allowed" : "quiet"}
              dot={twoFactorRequired}
              data-policy={twoFactorRequired ? "required" : "optional"}
            >
              {twoFactorRequired
                ? t("twoFactorRequired")
                : t("twoFactorOptional")}
            </Badge>
            <InviteDialog
              org={org}
              pendingIds={members.invitations.map((i) => i.id)}
              allowed
              twoFactorRequired={twoFactorRequired}
              after={routes.organization(org, "invitations")}
            />
          </div>
        </div>
        <ListTable
          label={t("tableLabel")}
          columns={columns}
          rows={rows}
          filters={[
            {
              key: "status",
              label: t("filters.status"),
              options: [
                { value: "active", label: t("statusActive") },
                { value: "invited", label: t("statusInvited") },
              ],
            },
            {
              key: "twoFactor",
              label: t("filters.twoFactor"),
              options: [
                { value: "totp", label: t("twoFactorMethods.totp") },
                { value: "hardware", label: t("twoFactorMethods.hardware") },
                { value: "passkey", label: t("twoFactorMethods.passkey") },
                {
                  value: "passkeyTotp",
                  label: t("twoFactorMethods.passkeyTotp"),
                },
              ],
              unrecorded: t("twoFactorUnrecorded"),
            },
          ]}
          empty={members.members.length === 0 ? t("empty") : t("noMatch")}
        />
        <div className={panelBody}>
          <p className={note}>{t("note")}</p>
        </div>
      </section>
      <RolesInUse org={org} members={members} roles={roles} />
    </div>
  );
}

/** The human roles the People table holds, with how many hold each. */
function RolesInUse({
  org,
  members,
  roles,
}: {
  org: string;
  members: MemberList;
  roles: RoleCatalog;
}) {
  const t = useTranslations("organization.people.inUse");
  const tRole = useTranslations("organization.roles");
  const held = new Map<Member["role"], number>();
  for (const member of members.members) {
    held.set(member.role, (held.get(member.role) ?? 0) + 1);
  }
  const describe = (role: Member["role"]): string | null =>
    roles.roles.find(
      (entry) => entry.kind === "human" && entry.name.toLowerCase() === role,
    )?.description ?? null;
  const agentRoles = roles.roles.filter((role) => role.kind === "agent").length;
  return (
    <section aria-labelledby="org-roles-in-use" className={panel}>
      <div className={panelHeader}>
        <h2 id="org-roles-in-use" className={panelTitle}>
          {t("title")}
        </h2>
        <SafeLink to={routes.roles(org)} className={buttonSecondary}>
          {t("manage")}
        </SafeLink>
      </div>
      <table aria-label={t("tableLabel")} className="w-full text-[13px]">
        <thead className="sr-only">
          <tr>
            <th scope="col">{t("role")}</th>
            <th scope="col">{t("holders")}</th>
            <th scope="col">{t("description")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {[...held.entries()].map(([role, count]) => (
            <tr key={role} data-role-in-use={role}>
              <td className={`${cell} ${mono} text-[11.5px]`}>{tRole(role)}</td>
              <td className={numericCell}>{count}</td>
              <td className={`${cell} text-[11.5px] text-dim`}>
                {describe(role) ?? t("noDescription")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={`${panelBody} text-[11.5px] text-dim`}>
        {t("footer", { agents: agentRoles })}
      </p>
    </section>
  );
}

export function InvitationsTab({
  org,
  members,
  twoFactorRequired,
}: {
  org: string;
  members: MemberList;
  twoFactorRequired: boolean;
}) {
  const t = useTranslations("organization.invitations");
  const tRole = useTranslations("organization.roles");
  const format = useFormatter();
  // A filter value is the day as the cell prints it, so an option and the
  // rows it keeps can never disagree on which day an instant falls in.
  const day = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium" });
  const sentDays = new Map<string, string>();
  const expiryDays = new Map<string, string>();
  const columns = [
    { label: t("email") },
    { label: t("role") },
    { label: t("invitedBy") },
    { label: t("sent") },
    { label: t("expires") },
    { label: t("actions"), hidden: true },
  ];
  const rows: ListRow[] = members.invitations.map((invitation) => {
    const sent = day(invitation.invitedAt);
    sentDays.set(invitation.invitedAt, sent);
    const expires: string | null =
      invitation.expiresAt === null ? null : day(invitation.expiresAt);
    const values: Record<string, string> = { sent };
    if (expires !== null) values.expires = expires;
    if (invitation.expiresAt !== null && expires !== null)
      expiryDays.set(invitation.expiresAt, expires);
    return {
      key: invitation.id,
      rowId: invitation.id,
      values,
      cells: [
        <span key="email" className={`${mono} text-xs`}>
          {invitation.email}
        </span>,
        <span key="role" className={`${mono} text-[11.5px]`}>
          {tRole(invitation.role)}
        </span>,
        <NotRecorded key="by" />,
        <DateCell key="sent" iso={invitation.invitedAt} />,
        invitation.expiresAt === null ? (
          <span key="expires">{t("never")}</span>
        ) : (
          <DateCell key="expires" iso={invitation.expiresAt} />
        ),
        <InvitationControls
          key="actions"
          org={org}
          invitationId={invitation.id}
          allowed
        />,
      ],
    };
  });
  /** One option per day, earliest first, as the cells print them. */
  const options = (days: ReadonlyMap<string, string>) => {
    const seen = new Set<string>();
    return [...days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([, label]) => {
        if (seen.has(label)) return [];
        seen.add(label);
        return [{ value: label, label }];
      });
  };
  return (
    <section aria-labelledby="org-invitations" className={panel}>
      <div className={panelHeader}>
        <h2 id="org-invitations" className={panelTitle}>
          {t("title")}
        </h2>
        <InviteDialog
          org={org}
          pendingIds={members.invitations.map((i) => i.id)}
          allowed
          twoFactorRequired={twoFactorRequired}
          after={routes.organization(org, "invitations")}
        />
      </div>
      <ListTable
        label={t("tableLabel")}
        columns={columns}
        rows={rows}
        filters={[
          { key: "sent", label: t("filters.sent"), options: options(sentDays) },
          {
            key: "expires",
            label: t("filters.expires"),
            options: options(expiryDays),
          },
        ]}
        empty={members.invitations.length === 0 ? t("empty") : t("noMatch")}
      />
    </section>
  );
}
