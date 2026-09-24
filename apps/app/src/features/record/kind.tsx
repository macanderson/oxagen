// A record kind's face (mockup `KINDS`, `kindBadge`, `kindGlyph`): a glyph and
// a hue, never a hue alone. The six hues are the kind palette (`--k-*`, mapped
// to `--color-kind-*` in globals.css); none of them is a state hue and none is
// the brand gold, so a reader never mistakes what a record IS for how it is
// DOING. The class strings are written out in full per kind because Tailwind
// only generates the classes it can read in the source.
import {
  ArrowRight,
  Bookmark,
  Heart,
  List,
  type LucideIcon,
  ShieldMinus,
  Target,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { RecordKind } from "@/data/contracts/steering";

type Face = {
  icon: LucideIcon;
  /** The kind hue as ink. */
  ink: string;
  /** `.kb`: ink, 45% of the hue on the border, 12% behind. */
  badge: string;
  /** `.kt`: ink, 32% of the hue on the border, 14% behind. */
  tile: string;
  /** `.crec-steps li::marker` and the related card's rule. */
  marker: string;
  rule: string;
};

export const KIND_FACE: Record<RecordKind, Face> = {
  rule: {
    icon: ArrowRight,
    ink: "text-kind-rule",
    badge: "text-kind-rule border-kind-rule/45 bg-kind-rule/12",
    tile: "text-kind-rule border-kind-rule/32 bg-kind-rule/14",
    marker: "marker:text-kind-rule",
    rule: "border-l-kind-rule",
  },
  constraint: {
    icon: ShieldMinus,
    ink: "text-kind-constraint",
    badge:
      "text-kind-constraint border-kind-constraint/45 bg-kind-constraint/12",
    tile: "text-kind-constraint border-kind-constraint/32 bg-kind-constraint/14",
    marker: "marker:text-kind-constraint",
    rule: "border-l-kind-constraint",
  },
  procedure: {
    icon: List,
    ink: "text-kind-procedure",
    badge: "text-kind-procedure border-kind-procedure/45 bg-kind-procedure/12",
    tile: "text-kind-procedure border-kind-procedure/32 bg-kind-procedure/14",
    marker: "marker:text-kind-procedure",
    rule: "border-l-kind-procedure",
  },
  fact: {
    icon: Target,
    ink: "text-kind-fact",
    badge: "text-kind-fact border-kind-fact/45 bg-kind-fact/12",
    tile: "text-kind-fact border-kind-fact/32 bg-kind-fact/14",
    marker: "marker:text-kind-fact",
    rule: "border-l-kind-fact",
  },
  memory: {
    icon: Bookmark,
    ink: "text-kind-memory",
    badge: "text-kind-memory border-kind-memory/45 bg-kind-memory/12",
    tile: "text-kind-memory border-kind-memory/32 bg-kind-memory/14",
    marker: "marker:text-kind-memory",
    rule: "border-l-kind-memory",
  },
  preference: {
    icon: Heart,
    ink: "text-kind-preference",
    badge:
      "text-kind-preference border-kind-preference/45 bg-kind-preference/12",
    tile: "text-kind-preference border-kind-preference/32 bg-kind-preference/14",
    marker: "marker:text-kind-preference",
    rule: "border-l-kind-preference",
  },
};

/** `.kb`: the kind's glyph and its name in caps, in the kind hue. */
export function KindBadge({ kind }: { kind: RecordKind }) {
  const term = useTranslations("ui.record");
  const t = useTranslations("record.header.kindLine");
  const { icon: Icon, badge } = KIND_FACE[kind];
  return (
    <span
      data-term="kind"
      data-kind={kind}
      title={t(kind)}
      className={`inline-flex items-center gap-[5px] whitespace-nowrap rounded-md border py-0.5 pr-2 pl-1.5 text-[11px] font-semibold uppercase leading-normal tracking-[0.05em] ${badge}`}
    >
      <Icon aria-hidden="true" className="size-3" />
      {term(`kinds.${kind}`)}
    </span>
  );
}

/** `.kt`: the kind glyph in a tinted tile, beside a statement. */
export function KindTile({
  kind,
  size = "md",
}: {
  kind: RecordKind;
  size?: "md" | "sm";
}) {
  const { icon: Icon, tile } = KIND_FACE[kind];
  const box =
    size === "md" ? "size-9 rounded-[9px]" : "size-[34px] rounded-[9px]";
  return (
    <span
      aria-hidden="true"
      data-kind={kind}
      className={`mt-0.5 grid flex-none place-items-center border ${box} ${tile}`}
    >
      <Icon className={size === "md" ? "size-[18px]" : "size-[17px]"} />
    </span>
  );
}
