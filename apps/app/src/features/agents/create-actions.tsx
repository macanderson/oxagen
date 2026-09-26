// The Agents header's two actions (agents.md, Header; ADR-192). An agent is
// one operator on one runtime with one harness, so every way to a new agent is
// the register flow: Register an agent, the one gold action on the page, opens
// it at its first step, and Add a runtime leaves for the Runtimes page, where
// naming a runtime goes straight on to registering its agent. The empty state
// carries both.
import { useTranslations } from "next-intl";
import { routes } from "@/shared/safe-path";
import { buttonPrimary, buttonSecondary } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";

type Place = { org: string; ws: string };

export function RegisterAgentLink({ org, ws }: Place) {
  const t = useTranslations("agents.list.create");
  return (
    <SafeLink
      to={routes.register(org, ws, "name")}
      className={buttonPrimary}
      data-testid="agents-register"
    >
      {t("register")}
    </SafeLink>
  );
}

export function AddRuntimeLink({ org, ws }: Place) {
  const t = useTranslations("agents.list.create");
  return (
    <SafeLink
      to={routes.runtimes(org, ws)}
      className={buttonSecondary}
      data-testid="agents-add-runtime"
    >
      {t("addRuntime")}
    </SafeLink>
  );
}

export function AgentsCreate({ org, ws }: Place) {
  return (
    <>
      <AddRuntimeLink org={org} ws={ws} />
      <RegisterAgentLink org={org} ws={ws} />
    </>
  );
}
