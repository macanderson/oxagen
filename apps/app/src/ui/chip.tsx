// The one chip every Mission Control badge renders through: icon + label, a
// tone from house tokens, and an optional description exposed as the title.
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "./cx";
import { CHIP_TONE, ICON_TONE, type Tone } from "./tone";

export type ChipProps = {
  tone: Tone;
  icon: LucideIcon;
  label: ReactNode;
  /** Longer explanation, shown on hover and read as the accessible description. */
  description?: string | undefined;
  /** A dashed hairline: a value that is not recorded, or a person still stands in the way. */
  dashed?: boolean | undefined;
  /** Machine vocabulary shown as recorded (tier, basis): monospace, lower case. */
  mono?: boolean | undefined;
  /** Extra content after the label (the verdict's fail → pass flourish). */
  suffix?: ReactNode;
  className?: string | undefined;
  "data-testid"?: string | undefined;
};

export function Chip({
  tone,
  icon: Icon,
  label,
  description,
  dashed,
  mono,
  suffix,
  className,
  "data-testid": testId,
}: ChipProps) {
  return (
    <span
      title={description}
      data-tone={tone}
      data-testid={testId}
      className={cx(
        "inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-xs font-medium leading-4",
        CHIP_TONE[tone],
        dashed && "border-dashed",
        mono && "font-mono text-[11px] lowercase",
        className,
      )}
    >
      <Icon
        aria-hidden
        focusable={false}
        strokeWidth={2}
        className={cx("size-3 shrink-0", ICON_TONE[tone])}
      />
      <span className="truncate">{label}</span>
      {suffix ? <> {suffix}</> : null}
    </span>
  );
}
