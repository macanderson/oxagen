// The Identity section: the principal as Postgres records it, the roles on it
// and the long-lived credentials it holds (prefix and dates, never a secret).
import { useTranslations } from "next-intl";
import type { AgentDetail } from "@/data/contracts/agents";
import { mono } from "@/ui/control-styles";
import { cell, Table } from "@/ui/table";
import {
  AgentStatusBadge,
  Facts,
  Instant,
  NotRecordedValue,
  Panel,
} from "./parts";

function Roles({ roles }: { roles: AgentDetail["roles"] }) {
  const t = useTranslations("agents.detail.roles");
  return (
    <Panel id="agent-roles" title={t("title")} lead={t("lead")}>
      {roles.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <Table
          label={t("title")}
          columns={[
            { label: t("columns.role") },
            { label: t("columns.scope") },
            { label: t("columns.assigned") },
            { label: t("columns.expires") },
          ]}
        >
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
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

function Credentials({
  credentials,
}: {
  credentials: AgentDetail["credentials"];
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
            <tr key={credential.id}>
              <td className={cell}>
                <span className={mono}>{credential.prefix}</span>
                <span className="block text-xs text-muted-foreground">
                  {credential.name}
                </span>
              </td>
              <td className={cell}>
                <Instant at={credential.createdAt} />
              </td>
              <td className={cell}>
                {credential.lastUsedAt === null ? (
                  t("never")
                ) : (
                  <Instant at={credential.lastUsedAt} />
                )}
              </td>
              <td className={cell}>
                {credential.expiresAt === null ? (
                  t("noExpiry")
                ) : (
                  <Instant at={credential.expiresAt} />
                )}
              </td>
              <td className={cell}>
                {credential.revokedAt === null ? (
                  t("active")
                ) : (
                  <>
                    {t("revoked")} <Instant at={credential.revokedAt} />
                  </>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

export function IdentitySection({ detail }: { detail: AgentDetail }) {
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
      <Roles roles={detail.roles} />
      <div className="lg:col-span-2">
        <Credentials credentials={detail.credentials} />
      </div>
    </div>
  );
}
