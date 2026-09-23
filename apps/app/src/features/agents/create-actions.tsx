import { useTranslations } from "next-intl";
import { routes } from "@/shared/safe-path";
import { buttonPrimary } from "@/ui/control-styles";
import { CreateButton } from "@/ui/create-button";
import { SafeLink } from "@/ui/navigation";

export function AgentsCreate({ org, ws }: { org: string; ws: string }) {
  const t = useTranslations("agents.list.create");
  return (
    <>
      <SafeLink
        to={routes.register(org, ws, "name")}
        className={buttonPrimary}
        data-testid="agents-register"
      >
        {t("wrap")}
      </SafeLink>
      <CreateButton kind="agent" label={t("newAgent")} primary={false} />
    </>
  );
}
