import { Bot, Server, User } from "lucide-react";
import { useTranslations } from "next-intl";
import { Chip } from "./chip";
import type { PrincipalKind } from "@/data/contracts";

const PRINCIPAL_ICON = {
  human: User,
  agent: Bot,
  service: Server,
} as const satisfies Record<PrincipalKind, unknown>;

/** Which kind of principal IAM decided about. Module-scoped, so it cannot shadow RecordKindBadge (plan W6). */
export function PrincipalKindBadge({ kind }: { kind: PrincipalKind }) {
  const t = useTranslations("ui.principalKind");
  return (
    <Chip
      tone="neutral"
      icon={PRINCIPAL_ICON[kind]}
      label={t(`${kind}.label`)}
      description={t(`${kind}.description`)}
      data-testid="principal-kind-badge"
    />
  );
}
