import {
  Archive,
  CircleCheck,
  CircleDashed,
  CirclePause,
  Clock,
  Lock,
  Octagon,
  Pause,
  Play,
  Radio,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Chip } from "./chip";
import type { Tone } from "./tone";
import type { AgentStatus, RunStatus } from "@/data/contracts";

const STATUS = {
  live: { tone: "success", icon: Radio },
  parked: { tone: "info", icon: Clock },
  pausing: { tone: "info", icon: Pause },
  paused: { tone: "info", icon: Pause },
  resuming: { tone: "success", icon: Play },
  sealed: { tone: "neutral", icon: Lock },
  halted: { tone: "warning", icon: Octagon },
  compacted: { tone: "neutral", icon: Archive },
  unenrolled: { tone: "neutral", icon: CircleDashed },
  active: { tone: "success", icon: CircleCheck },
  suspended: { tone: "warning", icon: CirclePause },
  retired: { tone: "neutral", icon: Archive },
} as const satisfies Record<
  RunStatus | AgentStatus,
  { tone: Tone; icon: unknown }
>;

/** A run's lifecycle status or an agent's enrollment status. */
export function StatusBadge({ status }: { status: RunStatus | AgentStatus }) {
  const t = useTranslations("ui.status");
  const { tone, icon } = STATUS[status];
  return (
    <Chip
      tone={tone}
      icon={icon}
      label={t(`${status}.label`)}
      description={t(`${status}.description`)}
      data-testid="status-badge"
      suffix={
        status === "live" ? (
          <span
            aria-hidden
            className="size-1.5 rounded-full bg-success motion-safe:animate-pulse"
          />
        ) : null
      }
    />
  );
}
