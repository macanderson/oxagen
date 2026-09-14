import { CircleHelp, GitFork, Play, RotateCcw, ScanEye } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReplayGrade } from "@/data/contracts/common";
import { Chip } from "./chip";
import type { Tone } from "./tone";

// Weakest first (spec §8.4): inspect < view < fork < retry.
const GRADE = {
  inspect: { tone: "neutral", icon: ScanEye },
  view: { tone: "warning", icon: Play },
  fork: { tone: "info", icon: GitFork },
  retry: { tone: "success", icon: RotateCcw },
} as const satisfies Record<ReplayGrade, { tone: Tone; icon: unknown }>;

/** The replay grade as recorded. `null` says "not recorded". */
export function GradeBadge({ grade }: { grade: ReplayGrade | null }) {
  const t = useTranslations("ui.grade");
  const key = grade ?? "unknown";
  const { tone, icon } =
    grade === null
      ? { tone: "neutral" as const, icon: CircleHelp }
      : GRADE[grade];
  return (
    <Chip
      tone={tone}
      icon={icon}
      dashed={grade === null}
      label={t(`${key}.label`)}
      description={t(`${key}.description`)}
      data-testid="grade-badge"
    />
  );
}
