// Organization › People and Organization › Invitations (pages/organization.md):
// the members and the pending invitations of `list_members {scope:"org"}`,
// which the frame reads once and hands to both tabs.
//
// People: Person, Role, Workspaces, Two-factor, Last seen and Status, with
// Open, Change role and Remove on each row, then Roles in use, which counts
// the People table by role and takes each role's description from the role
// catalogue. `list_members` records a member's name, email, role and join
// date. It records no per-member workspaces, two-factor method or last sign-in,
// and no organization two-factor policy, so those cells say "not recorded"
// rather than a guess (macanderson/oxagen, the People issue this lane filed).
// Every member on the roster holds a membership row, so Status reads "active".
//
// Invitations: Email, Role offered, Invited by, Sent and Expires, with Resend
// and Revoke. The contract does not return who sent an invitation, so Invited
// by says "not recorded".
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
import { SafeLink } from "@/ui/navigation";
import { cell, numericCell } from "@/ui/table";
import { InvitationControls } from "./invitation-controls";
import { InviteDialog } from "./invite-dialog";
import { type ListRow, ListTable } from "./list-table";
import { MemberRowActions } from "./member-row-actions";
import { DateCell, NotRecorded, note } from "./parts";
import { DetailsDialog } from "./stub-dialog";

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

function MemberFacts({ member }: { member: Member }) {
  const t = useTranslations("organization.people.member");
  const tRole = useTranslations("organization.roles");
  const term = "text-muted-foreground";
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
      <dt className={term}>{t("email")}</dt>
      <dd className={mono}>{member.email}</dd>
      <dt className={term}>{t("role")}</dt>
      <dd className={mono}>{tRole(member.role)}</dd>
      <dt className={term}>{t("joined")}</dt>
      <dd>
        <DateCell iso={member.joinedAt} />
      </dd>
      <dt className={term}>{t("workspaces")}</dt>
      <dd>
        <NotRecorded />
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
  );
}

export function PeopleTab({
  org,
  members,
  roles,
}: {
  org: string;
  members: MemberList;
  roles: RoleCatalog;
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
    { label: t("actions") },
  ];
  const rows: ListRow[] = members.members.map((member) => ({
    key: member.id,
    rowId: member.id,
    search: `${member.name ?? ""} ${member.email} ${member.role}`,
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
      <div key="actions" className="flex flex-wrap gap-2">
        <DetailsDialog
          open={t("open")}
          title={t("member.title")}
          subtitle={member.name ?? member.email}
          testId={`member-${member.id}`}
        >
          <MemberFacts member={member} />
        </DetailsDialog>
        <MemberRowActions org={org} member={member} allowed after={here} />
      </div>,
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
            <Badge tone="quiet" dot={false} data-policy="two-factor">
              {t("twoFactorPolicy")}
            </Badge>
            <InviteDialog
              org={org}
              pendingIds={members.invitations.map((i) => i.id)}
              allowed
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
}: {
  org: string;
  members: MemberList;
}) {
  const t = useTranslations("organization.invitations");
  const tRole = useTranslations("organization.roles");
  const columns = [
    { label: t("email") },
    { label: t("role") },
    { label: t("invitedBy") },
    { label: t("sent") },
    { label: t("expires") },
    { label: t("actions") },
  ];
  const rows: ListRow[] = members.invitations.map((invitation) => ({
    key: invitation.id,
    rowId: invitation.id,
    search: `${invitation.email} ${invitation.role}`,
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
  }));
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
          after={routes.organization(org, "invitations")}
        />
      </div>
      <ListTable
        label={t("tableLabel")}
        columns={columns}
        rows={rows}
        empty={members.invitations.length === 0 ? t("empty") : t("noMatch")}
      />
    </section>
  );
}
