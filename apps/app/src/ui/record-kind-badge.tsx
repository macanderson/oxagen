import {
  ArrowRight,
  Bookmark,
  CircleDot,
  Heart,
  ListOrdered,
  ShieldMinus,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { RecordKind } from "@/data/contracts/common";
import { Chip } from "./chip";

// Identity is an icon, never a hue: per-kind colours fail colour-vision checks.
export const RECORD_KIND_ICON = {
  rule: ArrowRight,
  constraint: ShieldMinus,
  procedure: ListOrdered,
  fact: CircleDot,
  memory: Bookmark,
  preference: Heart,
} as const satisfies Record<RecordKind, unknown>;

/** A steering record's kind (one of the six real kinds, plan §6 Q5). */
export function RecordKindBadge({ kind }: { kind: RecordKind }) {
  const t = useTranslations("ui.recordKind");
  return (
    <Chip
      tone="neutral"
      icon={RECORD_KIND_ICON[kind]}
      label={t(`${kind}.label`)}
      description={t(`${kind}.description`)}
      data-testid="record-kind-badge"
    />
  );
}
