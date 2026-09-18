// The replay grade a seal recorded (spec §8.4): the strongest verb a reader
// can apply to the recording. The vocabulary is closed and ordered, weakest
// first, and it is computed once at seal, so this renders the recorded word
// and never a stronger one, and never derives a grade from anything on screen.
import { useTranslations } from "next-intl";
import type { ReplayGrade } from "@/data/contracts/runs";

/** Weakest first, so a caller can read the ladder's rank off the array. */
export const REPLAY_GRADES = ["inspect", "view", "fork", "retry"] as const;

export function ReplayGradeBadge({ grade }: { grade: ReplayGrade }) {
  const t = useTranslations("ui.replayGrade");
  return (
    <span
      data-grade={grade}
      title={t(`${grade}.help`)}
      className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-foreground"
    >
      <span aria-hidden="true" className="flex items-center gap-0.5">
        {REPLAY_GRADES.map((step, index) => (
          <span
            key={step}
            className={`h-2.5 w-1 rounded-[1px] ${
              index <= REPLAY_GRADES.indexOf(grade)
                ? "bg-foreground"
                : "bg-border"
            }`}
          />
        ))}
      </span>
      {t(`${grade}.label`)}
    </span>
  );
}
