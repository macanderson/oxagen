// The Enrollment section: the hosts enrolled under the agent's key, with the
// device key fingerprint, the collector and hook state the daemon reported and
// the policy bundle it last fetched. A report the daemon has not sent reads
// "not recorded".
//
// A row is its own client component (`host-row.tsx`) because its state turns
// on a clock that has to keep running; this section is the server half.
import { useTranslations } from "next-intl";
import type { AgentDetail } from "@/data/contracts/agents";
import { mono } from "@/ui/control-styles";
import { Table } from "@/ui/table";
import { HostRow } from "./host-row";
import { Panel } from "./parts";

export function EnrollmentSection({
  hosts,
  now,
}: {
  hosts: AgentDetail["hosts"];
  /** The instant the agent was read; an enrollment's expiry is judged against it. */
  now: number;
}) {
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
            <HostRow key={host.hostEnrollmentId} host={host} now={now} />
          ))}
        </Table>
      )}
    </Panel>
  );
}
