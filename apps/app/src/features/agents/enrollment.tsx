// The Enrollment section: the hosts enrolled under the agent's key, with the
// device key fingerprint, the collector and hook state the daemon reported and
// the policy bundle it last fetched. A report the daemon has not sent reads
// "not recorded".
//
// Two writes live here (#2953): Enroll a host mints the single-use token a
// machine presents to `enroll_host`, and Revoke on a row retires one host's
// key. Both are client components (`enrollment-controls.tsx`).
//
// A row is its own client component (`host-row.tsx`) because its state turns
// on a clock that has to keep running; this section is the server half.
import { useTranslations } from "next-intl";
import type { AgentDetail } from "@/data/contracts/agents";
import type { SafePath } from "@/shared/safe-path";
import { mono } from "@/ui/control-styles";
import { DesktopDownloads } from "@/ui/desktop-downloads";
import { Table } from "@/ui/table";
import { EnrollHost } from "./enrollment-controls";
import { HostRow } from "./host-row";
import { Panel } from "./parts";

export function EnrollmentSection({
  hosts,
  now,
  org,
  ws,
  agentId,
  agentName,
  retired,
  here,
}: {
  hosts: AgentDetail["hosts"];
  /** The instant the agent was read; an enrollment's expiry is judged against it. */
  now: number;
  org: string;
  ws: string;
  agentId: string;
  /** Named in the Enroll a host dialog, so it is clear which agent the machine joins. */
  agentName: string;
  /** A retired identity is archived, so `create_enrollment_token` cannot find it. */
  retired: boolean;
  /** This tab, re-read after a revoke. */
  here: SafePath;
}) {
  const t = useTranslations("agents.detail.enrollment");
  return (
    <Panel id="agent-hosts" title={t("title")} lead={t("lead")}>
      {/*
        Enroll a host sits above the table and stays there when the table is
        empty: the empty state prints the command a person would run from a
        checkout, and this is the same path for a machine they are sitting at.
        A retired identity is archived, and `create_enrollment_token` selects
        on `deletedAt is null`, so the control would only ever answer
        "agent_not_found". The header hides its writes for the same reason.
      */}
      {retired ? null : (
        <div className="flex flex-wrap justify-end gap-2">
          <EnrollHost
            org={org}
            ws={ws}
            agentId={agentId}
            agentName={agentName}
          />
        </div>
      )}
      {hosts.length === 0 ? (
        <div data-testid="hosts-empty" className="flex flex-col gap-2 text-sm">
          <p className="font-medium">{t("empty.title")}</p>
          <DesktopDownloads />
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
            { label: t("columns.actions") },
          ]}
        >
          {hosts.map((host) => (
            <HostRow
              key={host.hostEnrollmentId}
              host={host}
              now={now}
              org={org}
              ws={ws}
              here={here}
            />
          ))}
        </Table>
      )}
    </Panel>
  );
}
