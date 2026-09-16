// Organization › People (ARCHITECTURE.md §1.2): the organization's members and
// its pending invitations from list_members {scope:"org"}, under the tabs that
// link People and API keys. A refused or failed read replaces both sections;
// the tabs stay. Each member's row carries the two writes on a membership —
// change role and remove (WL-42) — which an Owner or an Admin makes and every
// other role sees refused. Invitations are sent from here with the People
// writes the #2964 lane adds.
import { useFormatter, useTranslations } from "next-intl";
import type { MemberList } from "@/data/contracts/org";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { OrgCtx, OrgRole } from "@/server/viewer";
import { routes, type SafePath } from "@/shared/safe-path";
import { mono } from "@/ui/control-styles";
import { OutcomePanel } from "@/ui/form-feedback";
import { MemberRowActions } from "./member-row-actions";
import { OrganizationTabs } from "./tabs";

/** The org roles the two membership handlers admit (INV-29). */
const MEMBERSHIP_WRITERS: readonly OrgRole[] = ["owner", "admin"];

export async function People({
  ctx,
  source,
}: {
  ctx: OrgCtx;
  source: DataSource;
}) {
  const read = await source.org.members(ctx);
  return <PeopleView orgSlug={ctx.orgSlug} orgRole={ctx.orgRole} read={read} />;
}

const sectionTitle = "text-base font-semibold text-foreground";
const table = "w-full text-left text-sm";
const headCell = "px-3 py-2 text-xs font-medium text-muted-foreground";
const cell = "px-3 py-2.5 align-top";
const emptyLine = "text-sm text-muted-foreground";

function PeopleView({
  orgSlug,
  orgRole,
  read,
}: {
  orgSlug: string;
  orgRole: OrgRole;
  read: Read<MemberList>;
}) {
  const t = useTranslations("organization");
  return (
    <div className="flex flex-col gap-6">
      <OrganizationTabs org={orgSlug} current="people" />
      {read.ok ? (
        <>
          <Members
            members={read.value.members}
            org={orgSlug}
            writes={MEMBERSHIP_WRITERS.includes(orgRole)}
            here={routes.people(orgSlug)}
          />
          <Invitations invitations={read.value.invitations} />
        </>
      ) : read.reason === "denied" ? (
        <OutcomePanel
          tone="deny"
          testId="people-denied"
          title={t("denied.title")}
        >
          {t("denied.body", {
            role: t(`roles.${orgRole}`),
            permission: read.permission,
          })}
        </OutcomePanel>
      ) : read.reason === "pending_approval" ? (
        <OutcomePanel
          tone="neutral"
          testId="people-pending"
          title={t("pending.title")}
        >
          {t("pending.body", { id: read.accessRequestId })}
        </OutcomePanel>
      ) : (
        <OutcomePanel
          tone="neutral"
          testId="people-error"
          title={t("error.title")}
        >
          {t("error.body", { status: read.status, code: read.code })}
        </OutcomePanel>
      )}
    </div>
  );
}

function DateCell({ iso }: { iso: string }) {
  const format = useFormatter();
  return (
    <time dateTime={iso}>
      {format.dateTime(new Date(iso), { dateStyle: "medium" })}
    </time>
  );
}

function Members({
  members,
  org,
  writes,
  here,
}: {
  members: MemberList["members"];
  org: string;
  /** Whether this viewer's org role may change a role and remove a member. */
  writes: boolean;
  /** This page, reloaded after a membership changed. */
  here: SafePath;
}) {
  const t = useTranslations("organization");
  return (
    <section aria-labelledby="people-members" className="flex flex-col gap-3">
      <h2 id="people-members" className={sectionTitle}>
        {t("people.title")}
      </h2>
      {members.length === 0 ? (
        <p className={emptyLine}>{t("people.empty")}</p>
      ) : (
        <table className={table}>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={headCell}>
                {t("people.person")}
              </th>
              <th scope="col" className={headCell}>
                {t("people.role")}
              </th>
              <th scope="col" className={headCell}>
                {t("people.joined")}
              </th>
              <th scope="col" className={headCell}>
                {t("people.actions")}
              </th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr
                key={member.id}
                data-member={member.id}
                className="border-b border-border last:border-0"
              >
                <td className={cell}>
                  <div className="font-medium text-foreground">
                    {member.name ?? member.email}
                  </div>
                  {member.name === null ? null : (
                    <div className={`${mono} text-muted-foreground`}>
                      {member.email}
                    </div>
                  )}
                </td>
                <td className={cell}>{t(`roles.${member.role}`)}</td>
                <td className={cell}>
                  <DateCell iso={member.joinedAt} />
                </td>
                <td className={cell}>
                  <MemberRowActions
                    org={org}
                    member={member}
                    allowed={writes}
                    after={here}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Invitations({
  invitations,
}: {
  invitations: MemberList["invitations"];
}) {
  const t = useTranslations("organization");
  return (
    <section
      aria-labelledby="people-invitations"
      className="flex flex-col gap-3"
    >
      <h2 id="people-invitations" className={sectionTitle}>
        {t("invitations.title")}
      </h2>
      {invitations.length === 0 ? (
        <p className={emptyLine}>{t("invitations.empty")}</p>
      ) : (
        <table className={table}>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={headCell}>
                {t("invitations.email")}
              </th>
              <th scope="col" className={headCell}>
                {t("invitations.role")}
              </th>
              <th scope="col" className={headCell}>
                {t("invitations.sent")}
              </th>
              <th scope="col" className={headCell}>
                {t("invitations.expires")}
              </th>
            </tr>
          </thead>
          <tbody>
            {invitations.map((invitation) => (
              <tr
                key={invitation.id}
                data-invitation={invitation.id}
                className="border-b border-border last:border-0"
              >
                <td className={`${cell} ${mono}`}>{invitation.email}</td>
                <td className={cell}>{t(`roles.${invitation.role}`)}</td>
                <td className={cell}>
                  <DateCell iso={invitation.invitedAt} />
                </td>
                <td className={cell}>
                  {invitation.expiresAt === null ? (
                    t("invitations.never")
                  ) : (
                    <DateCell iso={invitation.expiresAt} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
