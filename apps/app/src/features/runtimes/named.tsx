// The cells a named runtime (`list_runtimes`, ADR-198) is drawn with, in the
// Runtimes tab's row and in its drawer: the live agents on it, each avatar
// badged with its harness, and when a host last reported.
//
// A runtime is a slot, not a machine: a laptop replaced by another keeps its
// runtime, and its agents keep their principals.
import { useTranslations } from "next-intl";
import type { NamedRuntime } from "@/data/contracts/runtimes";
import { AgentAvatar } from "@/ui/agent-avatar";
import { mono } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { Sub } from "./parts";

export function AgentsCell({ runtime }: { runtime: NamedRuntime }) {
  const t = useTranslations("runtimes");
  if (runtime.agents.length === 0)
    return <span className="text-muted-foreground">{t("named.noAgent")}</span>;
  return (
    <ul className="flex flex-col gap-0.5">
      {runtime.agents.map((agent) => (
        <li
          key={agent.id}
          data-testid="named-runtime-agent"
          className="flex min-w-0 items-center gap-2"
        >
          <AgentAvatar
            value={null}
            initials={agent.slug.slice(0, 2).toUpperCase()}
            harness={agent.harness}
            size={24}
          />
          <span className="min-w-0">
            <span className={`${mono} block md:truncate`}>{agent.slug}</span>
            <Sub>{t(`harness.${agent.harness}`)}</Sub>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function LastSeen({ at }: { at: string | null }) {
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
