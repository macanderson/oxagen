// The Enrollment section: the hosts enrolled under the agent's key, with the
// device key fingerprint, the collector and hook state the daemon reported and
// the policy bundle it last fetched. A report the daemon has not sent reads
// "not recorded".
import { useLocale, useTranslations } from "next-intl";
import type { AgentDetail } from "@/data/contracts/agents";
import { mono } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { cell, Table } from "@/ui/table";
import { Instant, NotRecordedValue, Panel } from "./parts";

type Host = AgentDetail["hosts"][number];

function hooksKey(ok: boolean | null) {
  if (ok === null) return "unreported";
  return ok ? "ok" : "missing";
}

function HostRow({ host }: { host: Host }) {
  const t = useTranslations("agents.detail.enrollment");
  const locale = useLocale();
  return (
    <tr data-testid="host-row">
      <td className={cell}>
        {host.hostname}
        <span className={`${mono} block text-xs text-muted-foreground`}>
          {host.platform}
        </span>
      </td>
      <td className={cell}>
        <span className={mono}>{host.status}</span>
        {host.revokedAt === null ? null : (
          <span className="block text-xs text-muted-foreground">
            {t("revoked")} <Instant at={host.revokedAt} />
          </span>
        )}
      </td>
      <td className={cell}>
        <span className={mono}>{host.mode}</span>
      </td>
      <td className={cell}>
        {host.collectorVersion === null ? (
          <NotRecordedValue />
        ) : (
          <span className={mono}>{host.collectorVersion}</span>
        )}
      </td>
      <td className={cell} data-hooks={hooksKey(host.hooksOk)}>
        {t(`hooks.${hooksKey(host.hooksOk)}`)}
      </td>
      <td className={cell}>
        {host.bundleVersionServed === null ? (
          <NotRecordedValue />
        ) : (
          t("bundleVersion", {
            version: formatCount(host.bundleVersionServed, locale),
          })
        )}
      </td>
      <td className={cell}>
        <span className={`${mono} break-all`}>{host.deviceKeyFingerprint}</span>
      </td>
      <td className={cell}>
        {host.lastSeenAt === null ? (
          t("never")
        ) : (
          <Instant at={host.lastSeenAt} />
        )}
      </td>
    </tr>
  );
}

export function EnrollmentSection({ hosts }: { hosts: AgentDetail["hosts"] }) {
  const t = useTranslations("agents.detail.enrollment");
  return (
    <Panel id="agent-hosts" title={t("title")} lead={t("lead")}>
      {hosts.length === 0 ? (
        <div data-testid="hosts-empty" className="flex flex-col gap-2 text-sm">
          <p className="font-medium">{t("empty.title")}</p>
          <p className="text-muted-foreground">{t("empty.body")}</p>
          <code className={`${mono} self-start rounded-md bg-muted px-2 py-1`}>
            {t("empty.command")}
          </code>
        </div>
      ) : (
        <Table
          label={t("title")}
          columns={[
            { label: t("columns.host") },
            { label: t("columns.status") },
            { label: t("columns.mode") },
            { label: t("columns.collector") },
            { label: t("columns.hooks") },
            { label: t("columns.bundle") },
            { label: t("columns.deviceKey") },
            { label: t("columns.lastSeen") },
          ]}
        >
          {hosts.map((host) => (
            <HostRow key={host.hostEnrollmentId} host={host} />
          ))}
        </Table>
      )}
    </Panel>
  );
}
