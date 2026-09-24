// The replay grade a seal recorded (spec §8.4): the strongest verb a reader
// can apply to the recording. The vocabulary is closed and ordered, weakest
// first, and it is computed once at seal, so this renders the recorded word
// and never a stronger one, and never derives a grade from anything on screen.
//
// It is the mockup's `gradeBadge`: a state pill (`.b.b-<tone>`) whose tint
// says how much of the run the recording can bring back, with what the grade
// allows on hover.
import { useTranslations } from "next-intl";
import type { ReplayGrade } from "@/data/contracts/runs";
import { Badge, type BadgeTone } from "./badge";

/** `gradeBadge`'s tint, strongest first: a replay the record carries whole reads allowed. */
const TONE: Record<ReplayGrade, BadgeTone> = {
  retry: "allowed",
  fork: "allowed",
  view: "approval",
  inspect: "quiet",
};

export function ReplayGradeBadge({ grade }: { grade: ReplayGrade }) {
  const t = useTranslations("ui.replayGrade");
  return (
    <Badge
      tone={TONE[grade]}
      dot={false}
      title={t(`${grade}.help`)}
      data-grade={grade}
    >
      {t(`${grade}.badge`)}
    </Badge>
  );
}
