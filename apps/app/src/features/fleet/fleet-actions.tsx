// Fleet's one gold action (fleet.md: "Register Agent (gold; opens the
// three-step Register Agent gate)"). Runs are not started here, agents are
// registered here; the link opens the gate at its first step.
import { useTranslations } from "next-intl";
import { routes } from "@/shared/safe-path";
import { buttonPrimary } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";

export function FleetRegister({ org, ws }: { org: string; ws: string }) {
  const t = useTranslations("fleet.actions");
  return (
    <SafeLink
      to={routes.register(org, ws, "name")}
      data-testid="fleet-register"
      className={buttonPrimary}
    >
      {t("register")}
    </SafeLink>
  );
}
