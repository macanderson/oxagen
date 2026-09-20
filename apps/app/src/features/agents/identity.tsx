// The Identity section: the principal as Postgres records it, the roles on it
// and the long-lived credentials it holds (prefix and dates, never a secret).
//
// The Roles panel is where an agent's authority is changed (#2956). Assign and
// Revoke are drawn only for a viewer the handlers will accept, an organization
// Owner or Admin, and only while the identity is live: a retired principal
// holds no authority to widen, so offering a control that can only be refused
// would be worse than not offering it. Everyone else reads the same table.
//
// A credential row is its own client component (`credential-row.tsx`): its
// state is read off both fields that disqualify it, and the expiry half is
// judged against a clock that keeps running, so a row whose expiry passes
// while the page is open says "expired" rather than "active". The claim this
// page makes is what authority the agent actually holds.
import { useTranslations } from "next-intl";
import type { AgentDetail } from "@/data/contracts/agents";
import { mono } from "@/ui/control-styles";
import { cell, Table } from "@/ui/table";
import { CredentialRow } from "./credential-row";
import {
  AgentStatusBadge,
  Facts,
  Instant,
  NotRecordedValue,
  Panel,
} from "./parts";
import { AssignRole, type RoleTarget, RevokeRole } from "./role-controls";

function Roles({
  roles,
  manage,
}: {
  roles: AgentDetail["roles"];
  /** Where the writes go, or null for a reader who may not make them. */
  manage: RoleTarget | null;
}) {
  const t = useTranslations("agents.detail.roles");
  const columns = [
    { label: t("columns.role") },
    { label: t("columns.scope") },
    { label: t("columns.assigned") },
    { label: t("columns.expires") },
    ...(manage === null ? [] : [{ label: t("columns.actions") }]),
  ];
  return (
    <Panel id="agent-roles" title={t("title")} lead={t("lead")}>
      {manage === null ? null : (
        <div className="flex flex-wrap gap-2">
          <AssignRole {...manage} />
        </div>
      )}
      {roles.length === 0 ? (
        <p data-state="empty" className="text-sm text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <Table label={t("title")} columns={columns}>
          {roles.map((role) => (
            <tr key={role.id}>
              <td className={cell}>{role.name}</td>
              <td className={cell}>{t(`scope.${role.scopeKind}`)}</td>
              <td className={cell}>
                <Instant at={role.assignedAt} />
              </td>
              <td className={cell}>
                {role.expiresAt === null ? (
                  t("standing")
                ) : (
                  <Instant at={role.expiresAt} />
                )}
              </td>
              {manage === null ? null : (
                <td className={cell}>
                  <RevokeRole {...manage} roleName={role.name} />
                </td>
              )}
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

function Credentials({
  credentials,
  now,
}: {
  credentials: AgentDetail["credentials"];
  /** The instant the agent was read, against which an expiry is judged. */
  now: number;
}) {
  const t = useTranslations("agents.detail.credentials");
  return (
    <Panel id="agent-credentials" title={t("title")} lead={t("lead")}>
      {credentials.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <Table
          label={t("title")}
          columns={[
            { label: t("columns.key") },
            { label: t("columns.issued") },
            { label: t("columns.lastUsed") },
            { label: t("columns.expires") },
            { label: t("columns.state") },
          ]}
        >
          {credentials.map((credential) => (
            <CredentialRow
              key={credential.id}
              credential={credential}
              now={now}
            />
          ))}
        </Table>
      )}
    </Panel>
  );
}

export function IdentitySection({
  detail,
  now,
  manage,
}: {
  detail: AgentDetail;
  /** The instant the agent was read; a credential's expiry is judged against it. */
  now: number;
  /**
   * Where a role write goes, or null when this viewer may not make one. The
   * page decides, from the organization role the viewer holds and the status
   * the identity is in.
   */
  manage: RoleTarget | null;
}) {
  const t = useTranslations("agents");
  const { identity } = detail;
  const id = (value: string | null) =>
    value === null ? (
      <NotRecordedValue />
    ) : (
      <span className={mono}>{value}</span>
    );
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel
        id="agent-identity"
        title={t("detail.identity.title")}
        lead={t("detail.identity.lead")}
      >
        <Facts
          rows={[
            {
              term: t("detail.identity.agentKey"),
              value: id(identity.agentKey),
            },
            {
              term: t("detail.identity.principal"),
              value: id(identity.principalId),
            },
            {
              term: t("detail.identity.harness"),
              value: t(`harness.${identity.harness}`),
            },
            {
              term: t("detail.identity.operator"),
              value: id(identity.operatorId),
            },
            {
              term: t("detail.identity.status"),
              value: <AgentStatusBadge status={identity.status} />,
            },
            {
              term: t("detail.identity.registered"),
              value: <Instant at={identity.registeredAt} />,
            },
            {
              term: t("detail.identity.firstFrame"),
              value:
                identity.firstFrameAt === null ? (
                  t("detail.identity.noFrame")
                ) : (
                  <Instant at={identity.firstFrameAt} />
                ),
            },
          ]}
        />
      </Panel>
      <Roles roles={detail.roles} manage={manage} />
      <div className="lg:col-span-2">
        <Credentials credentials={detail.credentials} now={now} />
      </div>
    </div>
  );
}
