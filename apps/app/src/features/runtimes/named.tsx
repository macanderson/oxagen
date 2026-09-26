// The Runtimes panel over `list_runtimes` (ADR-198): each runtime the
// workspace named, the live agents on it with their harness, the host
// enrollments bound to it and when a host last reported.
//
// A runtime is a slot, not a machine: a laptop replaced by another keeps its
// runtime, and its agents keep their principals. A runtime with no agent yet
// offers Register an agent, the one way to put it to work.
import { useLocale, useTranslations } from "next-intl";
import type { NamedRuntime, NamedRuntimeList } from "@/data/contracts/runtimes";
import type { Read } from "@/data/read";
import { mono } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { formatCount } from "@/ui/money-format";
import { ReadFailure } from "@/ui/read-failure";
import { cell, numericCell, Table } from "@/ui/table";
import { RegisterOnRuntime } from "./controls";
import { Panel, Sub } from "./parts";

function AgentsCell({ runtime }: { runtime: NamedRuntime }) {
  const t = useTranslations("runtimes");
  if (runtime.agents.length === 0)
    return <span className="text-muted-foreground">{t("named.noAgent")}</span>;
  return (
    <ul className="flex flex-col gap-0.5">
      {runtime.agents.map((agent) => (
        <li key={agent.id} data-testid="named-runtime-agent">
          <span className={mono}>{agent.slug}</span>
          <Sub>{t(`harness.${agent.harness}`)}</Sub>
        </li>
      ))}
    </ul>
  );
}

function LastSeen({ at }: { at: string | null }) {
  const t = useTranslations("runtimes.named");
  const format = useFormatter();
  if (at === null)
    return <span className="text-muted-foreground">{t("never")}</span>;
  return (
    <time dateTime={at}>
      {format.dateTime(new Date(at), {
        dateStyle: "medium",
        timeStyle: "short",
      })}
    </time>
  );
}

export function NamedRuntimes({
  read,
  org,
  ws,
  canRegister,
}: {
  read: Read<NamedRuntimeList>;
  org: string;
  ws: string;
  /** Whether the viewer may register an agent (an org Owner or Admin). */
  canRegister: boolean;
}) {
  const t = useTranslations("runtimes.named");
  const locale = useLocale();
  if (!read.ok)
    return (
      <Panel id="runtimes-named" title={t("title")}>
        <div className="px-4 py-3.5">
          <ReadFailure read={read} section={t("title")} />
        </div>
      </Panel>
    );
  const { runtimes } = read.value;
  if (runtimes.length === 0)
    return (
      <Panel id="runtimes-named" title={t("title")} count={0}>
        <p
          data-testid="named-runtimes-none"
          className="px-4 py-3.5 text-sm text-muted-foreground"
        >
          {t("none")}
        </p>
      </Panel>
    );
  return (
    <Panel
      id="runtimes-named"
      title={t("title")}
      count={formatCount(runtimes.length, locale)}
    >
      <Table
        label={t("title")}
        columns={[
          { label: t("columns.runtime") },
          { label: t("columns.agents") },
          { label: t("columns.hosts"), numeric: true },
          { label: t("columns.lastSeen") },
        ]}
      >
        {runtimes.map((runtime) => (
          <tr
            key={runtime.id}
            data-testid="named-runtime"
            data-runtime={runtime.id}
            className="border-b border-border last:border-b-0"
          >
            <td className={cell}>
              <span className="font-medium">{runtime.name}</span>
              <Sub monoFace>{runtime.slug}</Sub>
            </td>
            <td className={cell}>
              <AgentsCell runtime={runtime} />
              {runtime.agents.length === 0 && canRegister ? (
                <div className="pt-1">
                  <RegisterOnRuntime
                    org={org}
                    ws={ws}
                    runtimeId={runtime.id}
                    runtimeName={runtime.name}
                  />
                </div>
              ) : null}
            </td>
            <td className={numericCell}>
              {formatCount(runtime.liveHosts, locale)}
            </td>
            <td className={cell}>
              <LastSeen at={runtime.lastSeenAt} />
            </td>
          </tr>
        ))}
      </Table>
    </Panel>
  );
}
